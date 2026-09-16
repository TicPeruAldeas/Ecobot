-- Esquema del bot ECO (donaciones de material reciclable, Aldeas Infantiles SOS Perú).
-- Tablas con prefijo eco_ para convivir en el MISMO proyecto Supabase con los otros
-- bots (knowledge_*/conversations, parenting_*, ia_*). Idempotente y no destructivo.
-- Correr en el SQL Editor de Supabase.

create extension if not exists pgcrypto;

-- ── Parámetros operativos (editables desde el panel) ───────────────────────
create table if not exists public.eco_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into public.eco_config (key, value) values
  ('cupos_por_fecha',     '5'),      -- capacidad por fecha (aplica a todas las rutas del día)
  ('anticipacion_horas',  '24'),     -- mínimo de horas entre la reserva y la hora de inicio del recojo
  ('hora_inicio_recojo',  '09:00'),  -- hora de referencia del recojo para calcular la anticipación
  ('horizonte_dias',      '30'),     -- hasta cuántos días adelante se ofrecen fechas
  ('max_fechas',          '6'),      -- cuántas fechas se muestran al donante
  ('recordatorio_horas',  '24'),     -- anticipación del recordatorio
  ('contacto_humano',     'Escríbenos a reciclaje@aldeasinfantiles.org.pe'),
  ('materiales',          'Papelería|Cartón|Plástico|Vidrio|RAEE (electrónicos)|Mobiliario|Luminarias|Ropa|Otros'),
  ('foto_obligatoria',    '1'),
  ('mensaje_bienvenida',  '¡Hola! Soy *ECO*, el asistente de reciclaje de Aldeas Infantiles SOS Perú. Te ayudo a programar el recojo de tus materiales reciclables en Lima y Callao. Tu donación se transforma en apoyo para niñas, niños y adolescentes.')
on conflict (key) do nothing;

-- ── Distritos y días de ruta ───────────────────────────────────────────────
-- dias: 1=lunes … 7=domingo (ISO). aliases: otras formas de escribir el distrito.
create table if not exists public.eco_distritos (
  id         uuid not null default gen_random_uuid(),
  nombre     text not null,
  aliases    text[] not null default '{}',
  dias       int[]  not null default '{}',
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id)
);
create unique index if not exists eco_distritos_nombre_key on public.eco_distritos (lower(nombre));

-- Catálogo inicial según "RUTAS OFICIALES" (lun–vie). Solo inserta si no existe.
insert into public.eco_distritos (nombre, aliases, dias) values
  ('San Isidro',             '{}',                                  '{1,5}'),
  ('Lince',                  '{}',                                  '{1,5}'),
  ('Surquillo',              '{}',                                  '{1,5}'),
  ('Miraflores',             '{}',                                  '{1,5}'),
  ('San Borja',              '{}',                                  '{1,5}'),
  ('Santiago de Surco',      '{Surco}',                             '{1,5}'),
  ('Barranco',               '{}',                                  '{1,5}'),
  ('Chorrillos',             '{}',                                  '{1,5}'),
  ('Surco Viejo',            '{}',                                  '{1,5}'),
  ('Villa El Salvador',      '{VES}',                               '{1}'),
  ('San Juan de Miraflores', '{SJM}',                               '{1}'),
  ('Villa María del Triunfo','{VMT,Villa Maria del Triunfo}',       '{1}'),
  ('Callao',                 '{Cercado del Callao}',                '{2,3}'),
  ('Magdalena del Mar',      '{Magdalena}',                         '{2}'),
  ('San Miguel',             '{}',                                  '{2}'),
  ('Pueblo Libre',           '{}',                                  '{2}'),
  ('Cercado de Lima',        '{Lima,Lima Cercado,Centro de Lima}',  '{2}'),
  ('Jesús María',            '{Jesus Maria}',                       '{2}'),
  ('Breña',                  '{Brena}',                             '{2}'),
  ('San Martín de Porres',   '{SMP,San Martin de Porres}',          '{3}'),
  ('Los Olivos',             '{}',                                  '{3}'),
  ('Independencia',          '{}',                                  '{3}'),
  ('Comas',                  '{}',                                  '{3}'),
  ('Carabayllo',             '{}',                                  '{3}'),
  ('Rímac',                  '{Rimac}',                             '{3}'),
  ('San Juan de Lurigancho', '{SJL}',                               '{4}'),
  ('Lurigancho',             '{Lurigancho-Chosica}',                '{4}'),
  ('Chosica',                '{}',                                  '{4}'),
  ('Huachipa',               '{}',                                  '{4}'),
  ('El Agustino',            '{Agustino}',                          '{4}'),
  ('Ate',                    '{Ate Vitarte,Vitarte}',               '{4}'),
  ('Santa Anita',            '{}',                                  '{4}'),
  ('San Luis',               '{}',                                  '{4}'),
  ('La Molina',              '{}',                                  '{4}'),
  ('Pachacámac',             '{Pachacamac}',                        '{5}'),
  ('Lurín',                  '{Lurin}',                             '{5}')
on conflict do nothing;

-- ── Fechas: bloqueos y cupo especial ───────────────────────────────────────
create table if not exists public.eco_fechas (
  fecha       date not null,
  bloqueada   boolean not null default false,
  motivo      text,
  cupo_maximo int,                 -- null = usa eco_config.cupos_por_fecha
  updated_at  timestamptz not null default now(),
  primary key (fecha)
);

-- ── Sesión del flujo conversacional (una por número) ───────────────────────
create table if not exists public.eco_sesiones (
  user_id    text not null,
  paso       text not null default 'inicio',
  datos      jsonb not null default '{}'::jsonb,
  nombre_wa  text,
  updated_at timestamptz not null default now(),
  primary key (user_id)
);

-- ── Reservas de recojo ─────────────────────────────────────────────────────
create table if not exists public.eco_reservas (
  id              uuid not null default gen_random_uuid(),
  codigo          text not null,
  user_id         text not null,                       -- teléfono (51XXXXXXXXX)
  tipo_donante    text not null default 'persona',     -- persona | empresa
  nombre          text not null,                       -- persona o contacto de la empresa
  documento_tipo  text,                                -- DNI | RUC
  documento       text,
  empresa         text,
  correo          text,
  distrito_id     uuid references public.eco_distritos (id),
  distrito        text not null,
  direccion       text not null,
  referencia      text,
  disponibilidad  text,                                -- lun_vie | incluye_sab
  horario         text,                                -- horario de atención del generador
  requisitos      text,                                -- requisitos de acceso (SCTR, documentos, EPP…)
  sunat           jsonb,                               -- respuesta normalizada de la consulta RUC
  materiales      text[] not null default '{}',
  cantidad        text,
  comentario      text,
  fotos           text[] not null default '{}',
  fecha_recojo    date not null,
  estado          text not null default 'programado',  -- programado | atendido | no_atendido | cancelado | cerrado
  fecha_anterior  date,
  reprogramaciones int not null default 0,
  nota            text,                                -- nota de cierre / observación del equipo
  kilos           numeric,                             -- resultado del recojo (opcional)
  recordatorio_enviado_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (id),
  constraint eco_reservas_codigo_key unique (codigo),
  constraint eco_reservas_estado_chk check (estado in ('programado','atendido','no_atendido','cancelado','cerrado'))
);
-- Por si la tabla ya existía de una versión anterior:
alter table public.eco_reservas drop column if exists make_enviado_at;
alter table public.eco_reservas drop column if exists make_error;
alter table public.eco_reservas add column if not exists disponibilidad text;
alter table public.eco_reservas add column if not exists horario text;
alter table public.eco_reservas add column if not exists requisitos text;
alter table public.eco_reservas add column if not exists sunat jsonb;
create index if not exists eco_reservas_fecha_estado_idx on public.eco_reservas (fecha_recojo, estado);
create index if not exists eco_reservas_user_idx on public.eco_reservas (user_id, created_at desc);
create index if not exists eco_reservas_created_idx on public.eco_reservas (created_at desc);

-- ── Trazabilidad de cada reserva ───────────────────────────────────────────
create table if not exists public.eco_reserva_eventos (
  id         uuid not null default gen_random_uuid(),
  reserva_id uuid not null references public.eco_reservas (id) on delete cascade,
  evento     text not null,        -- creada | reprogramada | cancelada | estado | recordatorio
  detalle    jsonb not null default '{}'::jsonb,
  actor      text not null default 'donante',   -- donante | sistema | admin:<usuario>
  created_at timestamptz not null default now(),
  primary key (id)
);
create index if not exists eco_reserva_eventos_reserva_idx on public.eco_reserva_eventos (reserva_id, created_at);

-- ── Historial de mensajes (para el panel) ──────────────────────────────────
create table if not exists public.eco_mensajes (
  id         uuid not null default gen_random_uuid(),
  user_id    text not null,
  role       text not null,        -- user | assistant
  message    text not null,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (id)
);
create index if not exists eco_mensajes_user_idx on public.eco_mensajes (user_id, created_at desc);

-- ── Panel: usuarios y auditoría ────────────────────────────────────────────
create table if not exists public.eco_admin_users (
  id            uuid not null default gen_random_uuid(),
  username      text not null,
  password_hash text not null,
  rol           text not null default 'logistica',   -- admin | logistica | lectura
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id)
);
create unique index if not exists eco_admin_users_username_key on public.eco_admin_users (lower(username));

create table if not exists public.eco_admin_audit (
  id         uuid not null default gen_random_uuid(),
  admin_user text,
  action     text not null,
  target     text,
  ip         text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (id)
);
create index if not exists eco_admin_audit_created_idx on public.eco_admin_audit (created_at desc);

-- ── Bucket de fotos (público, solo lectura anónima) ────────────────────────
insert into storage.buckets (id, name, public)
values ('eco-fotos', 'eco-fotos', true)
on conflict (id) do nothing;

-- ── Funciones ──────────────────────────────────────────────────────────────

-- Cupo efectivo de una fecha (override en eco_fechas o valor de config).
create or replace function public.eco_cupo_de_fecha(p_fecha date)
returns int language sql stable as $$
  select coalesce(
    (select cupo_maximo from public.eco_fechas where fecha = p_fecha),
    (select value::int from public.eco_config where key = 'cupos_por_fecha'),
    5);
$$;

-- Ocupación por fecha en un rango (solo reservas vivas).
create or replace function public.eco_ocupacion(p_desde date, p_hasta date)
returns table (fecha date, ocupados bigint) language sql stable as $$
  select fecha_recojo, count(*)
  from public.eco_reservas
  where fecha_recojo between p_desde and p_hasta
    and estado = 'programado'
  group by fecha_recojo;
$$;

-- Genera un código legible: ECO-AAMMDD-XXXX
create or replace function public.eco_nuevo_codigo()
returns text language plpgsql as $$
declare c text;
begin
  loop
    c := 'ECO-' || to_char(now() at time zone 'America/Lima', 'YYMMDD') || '-' || upper(substr(md5(random()::text), 1, 4));
    exit when not exists (select 1 from public.eco_reservas where codigo = c);
  end loop;
  return c;
end $$;

-- Crea una reserva verificando el cupo dentro de un lock por fecha
-- (dos usuarios no pueden tomar el mismo último cupo). Lanza 'CUPO_LLENO' o 'FECHA_BLOQUEADA'.
create or replace function public.eco_reservar(p jsonb)
returns public.eco_reservas language plpgsql as $$
declare
  v_fecha date := (p->>'fecha_recojo')::date;
  v_cupo int;
  v_ocupados int;
  v_bloq boolean;
  r public.eco_reservas;
begin
  perform pg_advisory_xact_lock(hashtext('eco_fecha:' || v_fecha::text));
  select coalesce(bloqueada, false) into v_bloq from public.eco_fechas where fecha = v_fecha;
  if coalesce(v_bloq, false) then raise exception 'FECHA_BLOQUEADA'; end if;
  v_cupo := public.eco_cupo_de_fecha(v_fecha);
  select count(*) into v_ocupados from public.eco_reservas where fecha_recojo = v_fecha and estado = 'programado';
  if v_ocupados >= v_cupo then raise exception 'CUPO_LLENO'; end if;

  insert into public.eco_reservas (
    codigo, user_id, tipo_donante, nombre, documento_tipo, documento, empresa, correo,
    distrito_id, distrito, direccion, referencia, disponibilidad, horario, requisitos, sunat,
    materiales, cantidad, comentario, fotos, fecha_recojo
  ) values (
    public.eco_nuevo_codigo(),
    p->>'user_id', coalesce(p->>'tipo_donante','persona'), p->>'nombre', p->>'documento_tipo', p->>'documento',
    p->>'empresa', p->>'correo',
    nullif(p->>'distrito_id','')::uuid, p->>'distrito', p->>'direccion', p->>'referencia',
    p->>'disponibilidad', p->>'horario', p->>'requisitos', case when jsonb_typeof(p->'sunat') = 'object' then p->'sunat' else null end,
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'materiales','[]'::jsonb)) x), '{}'),
    p->>'cantidad', p->>'comentario',
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'fotos','[]'::jsonb)) x), '{}'),
    v_fecha
  ) returning * into r;

  insert into public.eco_reserva_eventos (reserva_id, evento, detalle, actor)
  values (r.id, 'creada', jsonb_build_object('fecha', v_fecha), coalesce(p->>'actor','donante'));
  return r;
end $$;

-- Reprograma: libera el cupo anterior y toma el nuevo, con la misma verificación.
create or replace function public.eco_reprogramar(p_id uuid, p_fecha date, p_actor text default 'donante')
returns public.eco_reservas language plpgsql as $$
declare
  v_cupo int; v_ocupados int; v_bloq boolean; v_anterior date; r public.eco_reservas;
begin
  select * into r from public.eco_reservas where id = p_id for update;
  if r.id is null then raise exception 'NO_EXISTE'; end if;
  if r.estado <> 'programado' then raise exception 'ESTADO_INVALIDO'; end if;
  if r.fecha_recojo = p_fecha then raise exception 'MISMA_FECHA'; end if;
  v_anterior := r.fecha_recojo;

  perform pg_advisory_xact_lock(hashtext('eco_fecha:' || p_fecha::text));
  select coalesce(bloqueada, false) into v_bloq from public.eco_fechas where fecha = p_fecha;
  if coalesce(v_bloq, false) then raise exception 'FECHA_BLOQUEADA'; end if;
  v_cupo := public.eco_cupo_de_fecha(p_fecha);
  select count(*) into v_ocupados from public.eco_reservas where fecha_recojo = p_fecha and estado = 'programado';
  if v_ocupados >= v_cupo then raise exception 'CUPO_LLENO'; end if;

  update public.eco_reservas
     set fecha_anterior = v_anterior, fecha_recojo = p_fecha,
         reprogramaciones = reprogramaciones + 1,
         recordatorio_enviado_at = null, updated_at = now()
   where id = p_id returning * into r;

  insert into public.eco_reserva_eventos (reserva_id, evento, detalle, actor)
  values (p_id, 'reprogramada', jsonb_build_object('de', v_anterior, 'a', p_fecha), p_actor);
  return r;
end $$;

-- Cambio de estado con trazabilidad (cancelar libera el cupo automáticamente
-- porque la ocupación solo cuenta 'programado').
create or replace function public.eco_cambiar_estado(p_id uuid, p_estado text, p_nota text default null, p_actor text default 'sistema', p_kilos numeric default null)
returns public.eco_reservas language plpgsql as $$
declare r public.eco_reservas;
begin
  update public.eco_reservas
     set estado = p_estado,
         nota = coalesce(p_nota, nota),
         kilos = coalesce(p_kilos, kilos),
         updated_at = now()
   where id = p_id returning * into r;
  if r.id is null then raise exception 'NO_EXISTE'; end if;
  insert into public.eco_reserva_eventos (reserva_id, evento, detalle, actor)
  values (p_id, case when p_estado = 'cancelado' then 'cancelada' else 'estado' end,
          jsonb_build_object('estado', p_estado, 'nota', p_nota, 'kilos', p_kilos), p_actor);
  return r;
end $$;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-09-15 · Kilos por material al cerrar el recojo, constancias de donación
-- y correo. (Idempotente: se puede volver a correr el archivo completo.)
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.eco_reservas add column if not exists kilos_detalle jsonb;   -- { "Papel": 10, "Cartón": 25, ... }

insert into public.eco_config (key, value) values
  ('factores_impacto', '{"Papel":{"arboles":17,"agua":26500,"energia":4100,"co2":1400},"Cartón":{"arboles":8,"agua":7000,"energia":1500,"co2":800},"Papel periódico":{"arboles":12,"agua":18000,"energia":3000,"co2":1100},"PET (botellas)":{"arboles":0,"agua":1500,"energia":5700,"co2":2000},"Plástico mixto":{"arboles":0,"agua":1000,"energia":5000,"co2":1800},"RAEE":{"arboles":0,"agua":0,"energia":10000,"co2":2500},"Vidrio":{"arboles":0,"agua":0,"energia":1000,"co2":315},"Metal (aluminio)":{"arboles":0,"agua":0,"energia":14000,"co2":3000},"Otro":{"arboles":0,"agua":0,"energia":0,"co2":0}}'),
  ('platos_por_kg',      '0.186'),
  ('firmante_nombre',    ''),
  ('firmante_cargo',     'Director de Recaudación de Fondos'),
  ('organizacion',       'ALDEAS INFANTILES SOS PERU - ASOCIACION NACIONAL')
on conflict (key) do nothing;

create sequence if not exists public.eco_constancia_numero_seq;

create table if not exists public.eco_constancias (
  id           uuid not null default gen_random_uuid(),
  numero       int  not null default nextval('public.eco_constancia_numero_seq'),
  documento    text not null,           -- RUC/DNI del donante
  razon_social text not null,
  direccion    text,
  correo       text,
  desde        date not null,
  hasta        date not null,
  detalle      jsonb not null default '{}'::jsonb,   -- { material: kg }
  total        numeric not null default 0,
  impacto      jsonb not null default '{}'::jsonb,
  reservas     uuid[] not null default '{}',
  enviada_a    text,
  enviada_at   timestamptz,
  creada_por   text,
  created_at   timestamptz not null default now(),
  primary key (id)
);
create index if not exists eco_constancias_documento_idx on public.eco_constancias (documento, created_at desc);

-- Cambio de estado con kilos por material (reemplaza la firma anterior).
drop function if exists public.eco_cambiar_estado(uuid, text, text, text, numeric);
create or replace function public.eco_cambiar_estado(p_id uuid, p_estado text, p_nota text default null, p_actor text default 'sistema', p_kilos numeric default null, p_kilos_detalle jsonb default null)
returns public.eco_reservas language plpgsql as $$
declare r public.eco_reservas; v_total numeric;
begin
  if p_kilos_detalle is not null and jsonb_typeof(p_kilos_detalle) = 'object' then
    select coalesce(sum((v)::numeric), 0) into v_total from jsonb_each_text(p_kilos_detalle) as t(k, v) where v ~ '^[0-9]+(\.[0-9]+)?$';
  end if;
  update public.eco_reservas
     set estado = p_estado,
         nota = coalesce(p_nota, nota),
         kilos_detalle = coalesce(p_kilos_detalle, kilos_detalle),
         kilos = coalesce(v_total, p_kilos, kilos),
         updated_at = now()
   where id = p_id returning * into r;
  if r.id is null then raise exception 'NO_EXISTE'; end if;
  insert into public.eco_reserva_eventos (reserva_id, evento, detalle, actor)
  values (p_id, case when p_estado = 'cancelado' then 'cancelada' else 'estado' end,
          jsonb_build_object('estado', p_estado, 'nota', p_nota, 'kilos', r.kilos, 'kilos_detalle', p_kilos_detalle), p_actor);
  return r;
end $$;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-09-16 · Flujo según el guion del ECO anterior: zonas, código RESER-nnnnn,
-- peso mínimo y textos. (Idempotente.)
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.eco_distritos add column if not exists zona text;   -- p. ej. "Lima Sur"
create index if not exists eco_distritos_zona_idx on public.eco_distritos (zona);

-- Código correlativo legible (continúa la numeración del bot anterior).
create sequence if not exists public.eco_reserva_numero_seq start with 100;
create or replace function public.eco_nuevo_codigo()
returns text language plpgsql as $$
begin
  return 'RESER-' || lpad(nextval('public.eco_reserva_numero_seq')::text, 5, '0');
end $$;

insert into public.eco_config (key, value) values
  ('peso_minimo_kg', '250'),
  ('horario_recojo', '9:00 a. m. a 5:30 p. m.'),
  ('mensaje_peso_minimo', 'Antes de continuar con su programación, le recordamos que el peso mínimo requerido para el recojo es de *{peso} kg* por cada punto.
Como referencia, *un contenedor de cartón lleno de papel pesa aproximadamente entre 35 y 40 kg*; por ello, si desea donar únicamente papel, le sugerimos solicitar el recojo cuando cuente con el equivalente a *8 contenedores llenos*.

_Esta referencia no aplica para otros residuos como plástico, cartón, entre otros materiales, ya que su mayor volumen hace que, dentro del contenedor, representen un menor peso en comparación con el papel._'),
  ('mensaje_final', '✅ *¡Reserva registrada exitosamente!*

📋 *Cód. Reserva: {codigo}*

Estaremos evaluando la información ingresada y nos comunicaremos con usted para confirmar su reserva.

Recuerda que el horario de recolección es de {horario}.

*Gracias por contribuir con el reciclaje* ♻️')
on conflict (key) do nothing;

-- Bienvenida con el texto del ECO anterior ({nombre} se reemplaza por el nombre de WhatsApp).
-- Solo se reemplaza si nadie la editó desde el panel.
update public.eco_config
   set value = '¡Hola! *{nombre}*
Soy Eco ♻️, tu asistente de reciclaje.
Bienvenido(a) al Programa de Reciclaje Integral de Aldeas Infantiles SOS Perú, donde cada residuo reciclado se convierte en una oportunidad para la niñez, promoviendo un futuro más sostenible. 🌱✨

♻️ Reduce, reutiliza, recicla… ¡y transforma el mundo con nosotros!
📅 Agenda aquí tu recolección y únete al cambio.'
 where key = 'mensaje_bienvenida' and value like '¡Hola! Soy *ECO*%';

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-09-16 · Catálogo real de zonas/distritos/días (tomado del ECO en Chatfuel).
-- Se aplica UNA sola vez (eco_config.catalogo_version) para no pisar cambios hechos
-- después desde el panel → Rutas. Días ISO: 1=lun 2=mar 3=mié 4=jue 5=vie 6=sáb.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (select 1 from public.eco_config where key = 'catalogo_version' and value >= '2026-09-16') then
    create temp table eco_tmp_cat (nombre text, zona text, dias int[], aliases text[]) on commit drop;
    insert into eco_tmp_cat values
      -- 🔵 Callao
      ('Callao',                 'Callao',      '{3}',         '{Cercado del Callao}'),
      ('Magdalena del Mar',      'Callao',      '{3}',         '{Magdalena}'),
      ('San Miguel',             'Callao',      '{3}',         '{}'),
      ('Pueblo Libre',           'Callao',      '{3}',         '{}'),
      -- 🟠 Lima Sur
      ('Barranco',               'Lima Sur',    '{5}',         '{}'),
      ('Chorrillos',             'Lima Sur',    '{5}',         '{}'),
      ('Lurín',                  'Lima Sur',    '{5}',         '{Lurin}'),
      ('Santiago de Surco',      'Lima Sur',    '{1,5}',       '{Surco}'),
      ('Villa El Salvador',      'Lima Sur',    '{5}',         '{VES}'),
      ('San Juan de Miraflores', 'Lima Sur',    '{5}',         '{SJM}'),
      ('San Borja',              'Lima Sur',    '{1,4}',       '{}'),
      -- 🟣 Lima Norte
      ('Carabayllo',             'Lima Norte',  '{6}',         '{}'),
      ('Comas',                  'Lima Norte',  '{6}',         '{}'),
      ('Los Olivos',             'Lima Norte',  '{6}',         '{}'),
      ('San Martín de Porres',   'Lima Norte',  '{6}',         '{SMP,San Martin de Porres}'),
      ('Independencia',          'Lima Norte',  '{6}',         '{}'),
      ('Rímac',                  'Lima Norte',  '{3}',         '{Rimac}'),
      -- 🟡 Lima Centro
      ('Breña',                  'Lima Centro', '{6}',         '{Brena}'),
      ('Centro de Lima',         'Lima Centro', '{6}',         '{Cercado de Lima,Lima Cercado,Lima}'),
      ('Jesús María',            'Lima Centro', '{6}',         '{Jesus Maria}'),
      ('La Victoria',            'Lima Centro', '{6}',         '{}'),
      ('Lince',                  'Lima Centro', '{6}',         '{}'),
      ('Miraflores',             'Lima Centro', '{1,4,6}',     '{}'),
      ('San Isidro',             'Lima Centro', '{1,4,6}',     '{}'),
      ('Surquillo',              'Lima Centro', '{1,4}',       '{}'),
      -- 🟢 Lima Este
      ('Ate',                    'Lima Este',   '{2}',         '{Ate Vitarte,Vitarte}'),
      ('Huachipa',               'Lima Este',   '{2}',         '{}'),
      ('Santa Anita',            'Lima Este',   '{2}',         '{}'),
      ('La Molina',              'Lima Este',   '{2}',         '{}'),
      ('San Luis',               'Lima Este',   '{2}',         '{}'),
      ('El Agustino',            'Lima Este',   '{2}',         '{Agustino}'),
      ('San Juan de Lurigancho', 'Lima Este',   '{1,2,3,4,5}', '{SJL}'),
      ('Chosica',                'Lima Este',   '{2}',         '{Lurigancho-Chosica}');

    -- "Cercado de Lima" del catálogo inicial pasa a llamarse "Centro de Lima".
    update public.eco_distritos set nombre = 'Centro de Lima' where lower(nombre) = 'cercado de lima'
      and not exists (select 1 from public.eco_distritos where lower(nombre) = 'centro de lima');

    insert into public.eco_distritos (nombre, zona, dias, aliases, activo)
    select nombre, zona, dias, aliases, true from eco_tmp_cat
    on conflict ((lower(nombre))) do update
      set zona = excluded.zona, dias = excluded.dias, aliases = excluded.aliases, activo = true, updated_at = now();

    -- Lo que ya no está en la lista oficial queda inactivo (no se borra).
    update public.eco_distritos d set activo = false, updated_at = now()
     where not exists (select 1 from eco_tmp_cat t where lower(t.nombre) = lower(d.nombre));

    insert into public.eco_config (key, value) values ('catalogo_version', '2026-09-16')
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end $$;

notify pgrst, 'reload schema';

-- 2026-09-16 · Reinicio por inactividad (minutos), editable desde el panel.
insert into public.eco_config (key, value) values ('sesion_minutos', '30') on conflict (key) do nothing;

-- 2026-09-16 · Bienvenida exacta del ECO anterior (sin cambios de redacción).
update public.eco_config
   set value = '¡Hola! *{nombre}*
Soy Eco ♻️, tu asistente de reciclaje.
Bienvenido(a) al Programa de Reciclaje Integral de Aldeas Infantiles SOS Perú, donde cada residuo reciclado se convierte en una oportunidad para la niñez. Promoviendo un futuro más sostenible.🌱✨

♻️ Reduce, reutiliza, recicla… y transforma el mundo con nosotros!
📅 Agenda aquí tu recolección y únete al cambio', updated_at = now()
 where key = 'mensaje_bienvenida' and value like '¡Hola! *{nombre}*%';
