# SDP MERCH

Tienda **mobile-first** sin servidor de frontend: https://spidey000.github.io/sdp_merch/

- Cuatro productos: `L` lanyard 5 €, `P` parche 5 €, `Q` pack de 3 pegatinas 1 € y `Y` llavero 5 €.
- Carrito persistente en `localStorage`, fijo abajo, sin cuentas de usuario.
- Dos fotos por producto (imagen de estudio y foto real).
- Cobro mediante **Stripe Checkout** alojado (tarjeta y Bizum), con precios e importe calculados **en el servidor**.
- Concepto en metadatos y descripción de Stripe: `SDP MERCH L1 P2 Q3 Y1`. *El texto visible en el extracto del banco depende de Stripe/Bizum y no está garantizado.*
- **Stock físico compartido de 1.000 pegatinas**, descontando 3 por pack Q. Se pueden vender 333 packs; quedará una pegatina suelta sin vender. Cuando queden menos de 3 unidades, la web indica `SOLD OUT`.

## Estado real (1 de noviembre de 2026)

- ✅ **GitHub Pages** desplegado desde `main`.
- ✅ **Cloudflare Worker** `sdp-merch-api` publicado en `https://sdp-merch-api.jorge-m-1879.workers.dev`.
- ✅ **Base D1** `sdp-merch-stock` creada con jurisdicción **UE**, ID `bb14d751-71ad-4b38-95f8-4764fda13841`.
- ✅ Inventario inicial: **1.000 pegatinas físicas** (333 packs de tres + una pegatina suelta).
- ✅ Frontend configurado para consultar `/api/stock` en la API de Cloudflare.
- ⏳ **Stripe no está conectado**: faltan `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` en los secretos del Worker, activar métodos de pago y registrar `/api/stripe-webhook` en Stripe.
- 🔒 Hasta completar lo anterior, `ready:false` desactiva la compra; no aceptar pagos es el comportamiento seguro.

**No vuelvas a ejecutar la migración inicial creando una base distinta:** el stock real reside en la base identificada arriba. Nunca publiques claves Stripe en GitHub.

## Arquitectura

```
GitHub Pages (HTML, JS, CSS, fotos) ───→ Cloudflare Worker (API privada)
                                            ├── Stripe Checkout / webhook
                                            └── Cloudflare D1 (SQLite: stock/reservas)
```

No se puede descontar stock entre compradores usando únicamente `localStorage` o archivos estáticos de GitHub Pages. Stripe no debe recibir peticiones con claves secretas desde el navegador. La API de Cloudflare se prepara en `worker/`, pero **no recibe pagos hasta que se conecte una cuenta Stripe, se cree la base D1 y se publique el Worker**.

**No uses Vercel Hobby para la pasarela de esta tienda comercial:** sus condiciones restringen Hobby a uso no comercial. Cloudflare Workers + D1 evita exigir una suscripción Vercel Pro para el backend.

## Configuración inicial (desde tu ordenador, una sola vez)

Requisitos: una cuenta de [Stripe](https://dashboard.stripe.com/) con Bizum habilitado y una cuenta de [Cloudflare](https://dash.cloudflare.com/) con Workers.

1. Abre una terminal en `worker/` y autentícate:

   ```sh
   npx wrangler@latest login
   npx wrangler@latest d1 create sdp-merch-stock
   ```

2. Copia el `database_id` que muestra Wrangler y reemplaza `REPLACE_WITH_D1_DATABASE_ID` en `worker/wrangler.jsonc`. Usa la misma base D1 en producción.

3. Inicializa las tablas y el stock **una única vez**:

   ```sh
   npx wrangler@latest d1 migrations apply sdp-merch-stock --remote
   ```

   La migración `0001_initial.sql` crea las tablas e introduce **1.000 pegatinas físicas**. No uses una segunda base de datos para ventas reales ni reinicies el stock mediante una nueva migración.

4. En el panel de Stripe, activa **tarjetas y Bizum**. El acceso a Bizum está sujeto a los requisitos y aprobación de Stripe. Configura las claves **en Cloudflare, nunca en este repositorio**:

   ```sh
   npx wrangler@latest secret put STRIPE_SECRET_KEY
   npx wrangler@latest deploy
   ```

5. Wrangler mostrará la URL pública del Worker, por ejemplo `https://sdp-merch-api.<tu-subdominio>.workers.dev`. En Stripe → Developers → Webhooks → Add destination, usa:

   ```
   https://sdp-merch-api.<tu-subdominio>.workers.dev/api/stripe-webhook
   ```

   Suscribe el webhook a estos eventos:

   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`

   Copia el **signing secret** del webhook (`whsec_...`) directamente a Cloudflare:

   ```sh
   npx wrangler@latest secret put STRIPE_WEBHOOK_SECRET
   npx wrangler@latest deploy
   ```

   El proyecto estará disponible para pruebas cuando ambos secretos y la base de datos estén configurados.

6. En `index.html`, localiza `SHOP_CONFIG.apiBase` y escribe allí la URL exacta del Worker **sin barra final**, por ejemplo:

   ```js
   const SHOP_CONFIG = Object.freeze({ apiBase: 'https://sdp-merch-api.<tu-subdominio>.workers.dev' });
   ```

   Haz `git push` a `main` para actualizar GitHub Pages. Las imágenes no necesitan moverse.

7. Primero usa las claves y webhook de **modo prueba** de Stripe, y comprueba que un pago de prueba modifica el stock **solo una vez**. Para vender realmente, sustituye los secretos por los de modo real y configura el webhook de modo real. **No reproduzcas compras reales desde el modo prueba.**

### Comprobaciones

- `GET /api/stock` devuelve `{ "ready": true, "remaining": 1000, "packs": 333 }` con el sistema configurado. Si `ready:false`, no se ofrecen pagos.
- Añadir un pack reserva **3 unidades** durante aproximadamente 35 minutos; Stripe abre el checkout seguro con tarjeta y Bizum.
- Si la compra se paga, el webhook firma y confirma la operación; si expira o falla, se libera stock. Reservas abandonadas se reconcilian cuando se solicita stock o se inicia otro pedido.
- El webhook es idempotente: los reintentos no descuentan dos veces. El frontend consulta el pago en Stripe y no vacía el carrito por visitar simplemente la URL de éxito.
- El precio, cantidad máxima (99 por producto) y disponibilidad se validan de nuevo en el Worker; los valores enviados desde el navegador **nunca** se toman como precios fiables.

### Control administrativo del stock

Una vez creada la base, puedes consultar unidades físicas con:

```sh
npx wrangler@latest d1 execute sdp-merch-stock --remote --command "SELECT * FROM inventory"
```

Para una reposición real, ajusta el número de pegatinas **físicas disponibles** (no packs). Ejemplo de añadir 60 unidades:

```sh
npx wrangler@latest d1 execute sdp-merch-stock --remote --command "UPDATE inventory SET available=available+60 WHERE sku='Q'"
```

No contabilices como disponibles unidades que estén ya reservadas en checkouts pendientes. Lleva una conciliación con el panel de pagos de Stripe antes de hacer ajustes.

## Desarrollo y tests

`npm test` ejecuta pruebas sin claves ni red utilizando SQLite local (`node:sqlite`, Node 22+). Se comprueban precios, packs de 3, reservas atómicas, liberación idempotente y firma de webhooks.

Si se pierden las credenciales o el Worker está caído, el pago se deshabilita; la tienda sigue mostrando el catálogo y el carrito local.

## Pendiente para recibir pagos reales

- Conectar Stripe y habilitar **Bizum** y tarjetas en la cuenta de comercio.
- Crear D1, aplicar migración y desplegar Worker.
- Configurar los secretos directamente en Cloudflare y dar de alta el webhook en Stripe.
- Configurar en `index.html` la URL real del Worker.
- Definir las condiciones de entrega, contacto, devoluciones y datos comerciales antes de abrir ventas al público.

Ninguna clave privada ni número bancario debe subirse a GitHub.
