# SDP MERCH — tienda estática

Tienda *mobile-first* con fotografías reales del llavero, lanyard, parche bordado y pegatinas.

## Productos

| Referencia | Producto | Precio | Unidad |
|---|---|---:|---|
| L | Lanyard | 5 € | 1 unidad |
| P | Parche bordado | 5 € | 1 unidad |
| Q | Pegatinas | 1 € | **Pack de 3** (no se vende suelta) |
| Y | Llavero | 5 € | 1 unidad |

El concepto de pago se genera en el orden de las referencias presentes, sin incluir artículos con cantidad cero, como `SDP MERCH L2 P1 Q3 Y1`. Aquí `Q3` son **3 packs = 9 pegatinas**.

## Configuración imprescindible antes de publicar

En `index.html`, busca:

```js
const SHOP_CONFIG = Object.freeze({ bizumPhone: '' });
```

Sustituye la cadena vacía por el número de móvil real que recibirá el pago (por ejemplo, `bizumPhone: '6XXXXXXXX'`, cambiando las X por cifras reales). Hasta entonces, el flujo de pago mostrará **Pendiente de configurar** y deshabilitará copiar el destinatario. No se ha introducido un teléfono de ejemplo funcional para evitar pagos por error.

No metas credenciales, tokens o datos bancarios privados en un sitio estático. Un teléfono de cobro publicado será visible para cualquiera que visite la web.

## Cómo ponerla online

Es suficiente subir `index.html` y la carpeta `assets/` a cualquier hosting estático con HTTPS.

**GitHub Pages:** crea un repositorio, sube los archivos (el `index.html` debe estar en raíz) y entra en **Settings → Pages → Build and deployment → Deploy from a branch → main / (root) → Save**. Si se publica dentro de un subdirectorio de una URL de GitHub Pages, las rutas relativas incluidas seguirán funcionando.

**Sin instalar nada:** abre `index.html` en el navegador para comprobar el diseño. `localStorage` puede no persistir de forma fiable con el esquema `file://`; para probar la persistencia, abre el proyecto desde un servidor local (por ejemplo, `python3 -m http.server 8080`) o desde el hosting HTTPS.

## Cómo funciona

- El carrito se almacena en `localStorage` bajo la clave `sdp-merch-cart-v1`.
- El carrito queda en la misma página: barra fija inferior, edición de cantidades y panel de resumen; no hay navegación a un checkout independiente.
- Las cantidades van de 0 a 99 por producto, y el total se calcula en el navegador.
- Al continuar se muestran destinatario, importe y concepto y se ofrece copiar los valores o compartir el resumen.
- **No se hace ningún cobro, no se abre automáticamente un Bizum y no se verifica un pago.**
- El carrito persiste **en cada navegador/dispositivo individual**, pero no se sincroniza entre un móvil y un ordenador porque no hay backend ni identidad compartida.
- No existe inventario, pedidos registrados, gestión de envíos, administración ni confirmación automática. Es necesario acordar con el cliente cómo comunicar la compra y cómo se entrega.

## Límite de Bizum

No existe un formato público universal y documentado de enlace `bizum://...` que permita abrir la app bancaria predeterminada y prerrellenar teléfono, importe y concepto para transferencias entre particulares. No debe fingirse esa integración con enlaces inventados.

Para un botón real de **pago online con Bizum** que lleve la transacción y permita confirmarla, la persona vendedora tiene que contratar el servicio de pago para comercios con su banco y usar una pasarela compatible. La mayoría de integraciones requiere endpoints seguros del proveedor, un servicio de terceros o un backend. Una página estática podría redirigir a un enlace de cobro **ya creado y alojado por un proveedor**, pero un importe variable por carrito generalmente requiere crear enlaces de pago dinámicos desde un sistema autenticado.

Fuentes oficiales:
- https://bizum.com/es/metodo-de-pago-online/
- https://bizum.com/es/como-funciona/
- https://bizum.com/es/faqs/como-puedo-incluir-el-boton-de-bizum-en-la-web-de-mi-empresa-cuales-son-las-condiciones/

## Estructura

```text
index.html      interfaz, estilos y lógica (HTML/CSS/JS puros)
assets/         fotos comprimidas WebP y favicon
README.md       instrucciones
```

No se necesitan `npm install`, frameworks, dependencias externas ni build.