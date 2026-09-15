# ECO — Notas de configuración y puesta en marcha

Bot de WhatsApp de **Aldeas Infantiles SOS Perú** para donaciones de material reciclable. Reemplaza al ECO de Chatfuel + Calendly + Make. Solo WhatsApp Cloud API + Railway + Supabase; el panel `/admin` sustituye a la hoja de Google.
Última actualización: 2026-09-15.

> ⚠️ Este archivo **no contiene secretos**. Los valores viven en Railway.

---

## 1. Qué hace

| Etapa | Cómo lo resuelve |
|---|---|
| Bienvenida y consentimiento | Tarjeta con botones *Acepto / No por ahora*. Se recuerda 30 días (`CONSENT_DAYS`). |
| Identificación | Persona (nombre + DNI/RUC) o Empresa (RUC → **consulta SUNAT** trae la razón social y se confirma con un botón → contacto). Valida DNI 8 dígitos, RUC 11 dígitos con dígito verificador, correo. Si SUNAT no responde, pide la razón social a mano. |
| Atención y acceso | Días en que pueden atender (lun–vie / incluye sábados), horario y, para empresas, requisitos de acceso (SCTR, documentos, EPP). Si solo atienden lun–vie no se ofrecen sábados. *(punto 1 del correo de Erika, 2026-09-14)* |
| Donante recurrente | Si el número ya donó, ofrece reutilizar datos y dirección. |
| Ubicación | Distrito por texto con alias y tolerancia a errores (`SJL`, `Surco`, `mirafores`); lista si es ambiguo; catálogo administrable. |
| Materiales | Lista (configurable) con opción *Otros* y cantidad libre; sin límite de ítems. |
| Foto | Obligatoria (configurable). Se descarga de Meta y se guarda en Supabase Storage (`eco-fotos`, URL pública). |
| Fechas | Días de ruta del distrito + anticipación mínima (24 h hasta la hora de inicio) + bloqueos + cupos por fecha. Se muestran solo fechas usables. |
| Reserva | Función SQL `eco_reservar` con lock por fecha: dos personas no pueden tomar el último cupo. Código `ECO-AAMMDD-XXXX`. |
| Confirmación | Mensaje con código, fecha, dirección y materiales. La reserva queda en `eco_reservas` y se ve al instante en el panel. |
| Mis recojos | Reprogramar (libera cupo anterior, toma el nuevo) y cancelar (libera cupo). Todo con trazabilidad en `eco_reserva_eventos`. |
| Recordatorios | Barrido cada 10 min; avisa N horas antes (`recordatorio_horas`, default 24) por **WhatsApp y por correo**. El correo llega siempre; por WhatsApp, fuera de la ventana de 24 h Meta exige **plantilla aprobada** (ver §5). |
| Panel `/admin` | Resumen, reservas (estado, kilos por material, nota, reprogramar, cancelar, constancia de donación en PDF por correo), calendario (bloqueos, cupo especial), rutas, conversaciones, configuración, usuarios y auditoría, exportar Excel. |

---

## 2. Supabase

- Proyecto compartido con los otros bots. **Solo** se crean objetos con prefijo `eco_` y el bucket `eco-fotos`. No tocar `parenting_*`, `knowledge_*`, `ia_*`.
- Correr en el SQL Editor: `supabase/migrations/20260914120000_eco_schema.sql` (idempotente).
- Tablas: `eco_config`, `eco_distritos`, `eco_fechas`, `eco_sesiones`, `eco_reservas`, `eco_reserva_eventos`, `eco_mensajes`, `eco_admin_users`, `eco_admin_audit`.
- Funciones: `eco_reservar(jsonb)`, `eco_reprogramar(uuid, date, text)`, `eco_cambiar_estado(uuid, text, text, text, numeric)`, `eco_ocupacion(date, date)`, `eco_cupo_de_fecha(date)`.
- El catálogo inicial de distritos sale de la imagen *RUTAS OFICIALES* (lun–vie). Revísalo en el panel → Rutas.

---

## 3. Variables de entorno (Railway)

| Variable | Obligatoria | Qué es |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Proyecto compartido |
| `WHATSAPP_VERIFY_TOKEN` | ✅ | Lo inventas tú; el mismo va en el webhook de Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅ | `phone_number_id` del número de ECO (hoy *Hola Eco* 51 982 568 378, en Chatfuel) |
| `WHATSAPP_TOKEN` | ✅ | Token permanente (system user) para enviar |
| `ADMIN_SESSION_SECRET` | ✅ | Firma de la cookie del panel (cualquier cadena larga) |
| `META_APP_SECRET` (`_2`, `_3`…) | recomendada | App Secret de la app de Meta que recibe el webhook; valida la firma |
| `ADMIN_USERS` | recomendada | `usuario:clave:rol,…` (rol = `admin` \| `logistica` \| `lectura`) |
| `RUC_API_PROVIDER` | recomendada | `apisnet` (default) \| `apiperu` \| `decolecta` \| `custom`. Proveedor de consulta RUC/SUNAT |
| `RUC_API_TOKEN` | recomendada | Token del proveedor. Sin token, `apisnet` usa su v1 gratuita (con límite de consultas) |
| `RUC_API_URL` | solo custom | URL con `{ruc}` (otro proveedor con la misma respuesta JSON) |
| `WA_TEMPLATE_RECORDATORIO` | opcional | Nombre de la plantilla aprobada para recordatorios |
| `WA_TEMPLATE_RECORDATORIO_PARAMS` | opcional | Orden de los parámetros del cuerpo. Default `nombre,fecha,direccion,codigo` |
| `WA_TEMPLATE_CAMBIO` | opcional | Plantilla para avisar reprogramación/cancelación hecha desde el panel (params: nombre, código, cambio) |
| `WA_TEMPLATE_LANG` | opcional | Default `es` |
| `STORAGE_BUCKET` | opcional | Default `eco-fotos` |
| `SESSION_TTL_HOURS` | opcional | Inactividad que reinicia el flujo (12) |
| `CONSENT_DAYS` | opcional | Vigencia del consentimiento (30) |
| `REMINDER_SWEEP_MINUTES` | opcional | Frecuencia del barrido de recordatorios (10) |
| `INGEST_SECRET` | opcional | Bearer para `POST /simulate` (pruebas sin WhatsApp) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | recomendadas | Servidor SMTP del dominio (M365: `smtp.office365.com`:587 con SMTP autenticado habilitado en el buzón). Sin ellas, el correo queda desactivado |
| `MAIL_FROM` | opcional | Remitente visible. Default: el `SMTP_USER` |
| `MAIL_NOTIFY_TO` | opcional | Correos internos (logística) que reciben aviso de cada reserva nueva, separados por coma |

---

## 4. Meta / WhatsApp (mismo patrón que victoria-ia)

1. Crear (o reutilizar) una app de Meta con el producto WhatsApp; su **App Secret** → `META_APP_SECRET`.
2. Webhook: `https://<app>.up.railway.app/webhook`, campo **`messages`**, verify token = `WHATSAPP_VERIFY_TOKEN`.
3. **Suscribir la app a la WABA** "Chatbots Tic" (`364751233386113`). Sin esto la URL verifica pero no llega nada.
   Los mensajes de todos los números de la WABA llegan a todas las apps suscritas; ECO ignora los que no son de su `WHATSAPP_PHONE_NUMBER_ID`.
4. Migrar el número *Hola Eco*: quitarlo de Chatfuel (desconectar) para que Chatfuel deje de responder. Ambos no pueden contestar al mismo tiempo.
5. Token permanente: generarlo desde un **system user** del Business Manager con permisos `whatsapp_business_messaging` y `whatsapp_business_management`.

---

## 5. Plantillas (recordatorios y avisos desde el panel)

Meta solo permite texto libre dentro de las 24 h posteriores al último mensaje del usuario. Un recordatorio un día antes normalmente cae fuera, así que hay que crear plantillas en WhatsApp Manager → *Plantillas de mensaje* (categoría **Utility**):

**`eco_recordatorio`** (params: `{{1}}` nombre, `{{2}}` fecha, `{{3}}` dirección, `{{4}}` código)
> Hola {{1}} 👋 Te recordamos tu recojo de reciclaje programado para el {{2}} en {{3}} (código {{4}}). Ten los materiales listos. Si necesitas cambiar la fecha, responde *menú*.

**`eco_cambio`** (params: `{{1}}` nombre, `{{2}}` código, `{{3}}` cambio)
> Hola {{1}}. Tu recojo {{2}} fue {{3}}. Si tienes dudas, responde a este mensaje.

Cuando estén aprobadas: `WA_TEMPLATE_RECORDATORIO=eco_recordatorio`, `WA_TEMPLATE_CAMBIO=eco_cambio`.
Mientras no existan, el bot intenta texto libre; si Meta lo rechaza queda registrado en el historial de la reserva y no se reintenta.

---

## 6. Datos y reportes (sin Google Sheets)

Toda la información vive en Supabase (`eco_reservas`, `eco_reserva_eventos`, `eco_mensajes`). El panel `/admin` es la vista operativa:
- **Reservas**: ficha completa con fotos (Supabase Storage, URL pública), historial, SUNAT, estado, kilos y nota.
- **Exportar Excel** desde la pestaña Reservas con los filtros aplicados (mismo formato de columnas que la antigua hoja, más las nuevas).
- **Conversaciones**: todos los mensajes que llegan a ECO, por número, con el paso del flujo.

**Correo (SMTP desde aldeastic.org.pe)**: al reservar, reprogramar o cancelar, el donante recibe un correo (además del WhatsApp) y logística recibe un aviso interno con todos los datos y las fotos (`MAIL_NOTIFY_TO`). Los correos no dependen de la ventana de 24 h de Meta.

**Constancias de donación** (reemplaza el certificado que enviaba Make):
1. Al marcar un recojo como *atendido* o *cerrado* en el panel, se registran los **kilos por material** (Papel, Cartón, Papel periódico, PET, Plástico mixto, RAEE, Vidrio, Metal, Otro). Se guardan en `eco_reservas.kilos_detalle`.
2. En la ficha → *Constancia de donación…* se elige el período; el panel suma los kilos de todos los recojos atendidos del mismo RUC/DNI, calcula el impacto (árboles, agua, energía, CO₂, platos) con los factores por tonelada de la hoja "Valores en donación" (`eco_config.factores_impacto`, editables) y muestra la vista previa.
3. *Emitir y descargar PDF* o *Emitir y enviar por correo*: crea la constancia con número correlativo en `eco_constancias` y genera el PDF con el mismo texto de la constancia oficial. Las emitidas quedan listadas y se pueden reenviar.
4. Configurar en el panel → Configuración: `firmante_nombre`, `firmante_cargo`, `organizacion`, `platos_por_kg`.

**SCTR del personal** (punto 4 del correo de Erika): fuera del alcance del bot; el panel ya muestra los requisitos de acceso que pidió el generador.
---

## 7. Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/health` | Estado del servicio (indica si correo y SUNAT están activos) |
| GET/POST | `/webhook` | Verificación y mensajes de Meta |
| POST | `/simulate` | Simula un mensaje: `{ "user_id": "519…", "text": "hola" }` o `{ "button": "consent_ok" }` o `{ "image_url": "…" }`. Header `Authorization: Bearer <INGEST_SECRET>`. Devuelve las respuestas del bot. |
| — | `/admin` | Panel (login con `ADMIN_USERS` o tabla `eco_admin_users`) |

---

## 8. Pruebas locales

```bash
npm test          # validaciones, disponibilidad y recorrido completo del flujo (sin red)
npm start         # requiere .env (ver .env.example)
```

Prueba del flujo contra Supabase real sin WhatsApp:
```bash
curl -s -X POST http://localhost:3000/simulate -H "Authorization: Bearer $INGEST_SECRET" -H "Content-Type: application/json" -d '{"user_id":"51900000001","text":"hola"}'
```

---

## 9. Runbook: "ECO no responde"

1. Logs de Railway al enviar un mensaje real:
   - Nada → la app no está suscrita a la WABA, o el número sigue enrutado a Chatfuel.
   - `🔏 Firma de Meta inválida` → `META_APP_SECRET` no es el de la app que recibe.
   - `⏭️ Ignorando número ajeno` → `WHATSAPP_PHONE_NUMBER_ID` no coincide.
   - `📩 …` sin respuesta → error de Supabase (revisar que la migración esté corrida) o del token de envío.
2. `POST /simulate` aísla el flujo de la capa Meta.
3. Fotos: si falla la subida, revisar que el bucket `eco-fotos` exista y sea público.

---

## 10. Pendientes

- [ ] Crear y aprobar plantillas `eco_recordatorio` y `eco_cambio` en Meta.
- [ ] Migrar el número *Hola Eco* de Chatfuel a la app de Meta de ECO.
- [ ] Definir el texto real de `contacto_humano` en el panel → Configuración.
- [ ] Configurar `RUC_API_TOKEN` (ya configurado: decolecta) para no depender del límite gratuito.
- [ ] Habilitar SMTP autenticado en el buzón de aldeastic.org.pe (o contraseña de aplicación) y cargar `SMTP_*` en Railway.
- [ ] Definir `firmante_nombre` en el panel → Configuración para que la constancia salga firmada.
- [ ] (Opcional) Logo de Aldeas en el PDF de la constancia y en los correos.
- [ ] Revisar el catálogo de distritos/días en el panel → Rutas (la imagen tenía "Callao" en martes y miércoles).
- [ ] Arequipa: no incluido (el flujo actual de Chatfuel tenía una hoja aparte). Se puede añadir como distritos con su propia ruta.
