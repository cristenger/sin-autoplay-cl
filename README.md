# Sin Autoplay CL

Extensión Manifest V3 para bloquear la reproducción automática de video y audio. Actúa en todos los sitios compatibles con los permisos de la extensión, incluidos sus iframes.

## Instalación

1. Abre `chrome://extensions` y activa **Modo desarrollador**.
2. Selecciona **Cargar descomprimida** y elige esta carpeta.
3. Abre o recarga las páginas donde quieras usarla.

Después de actualizar el código, recarga la extensión y las pestañas abiertas para que reciban los scripts nuevos.

## Uso

El popup permite activar o desactivar la extensión, ocultar los reproductores y permitir videos en un sitio. Las excepciones se aplican al dominio guardado y a sus subdominios; en un iframe se toma el sitio visible en la barra del navegador.

En el modo de bloqueo, puedes reproducir con los controles nativos o con un botón Play del reproductor. También funcionan Enter y espacio en los controles accesibles. El permiso se conserva durante los reintentos y las pausas del mismo medio; un cambio de fuente necesita otra interacción.

Al activar el bloqueo se pausan las reproducciones automáticas que ya estaban en marcha. Las iniciadas manualmente se conservan. Al desactivar se restauran los atributos `autoplay` y `preload` modificados por la extensión.

Ocultar o pausar un reproductor no garantiza que el sitio deje de descargar contenido. Los reproductores personalizados pueden necesitar una adaptación de sus controles.

## Pruebas

Requisitos: Node.js 20 o posterior y Chromium de Playwright.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

También puedes usar un Chromium ya instalado:

```sh
CHROMIUM_EXECUTABLE="/ruta/al/ejecutable/chromium" npm test
```

Las pruebas cargan la extensión en un perfil temporal, sirven medios PCM silenciosos desde un servidor local y usan clics y teclas reales. La política de autoplay del navegador se configura para permitir reproducción automática, de modo que un bloqueo solo pueda atribuirse a la extensión. Un caso adicional simula una lectura tardía de storage para comprobar la carrera de inicio.

Se cubren autoplay declarativo y programático, gestos sintéticos, controles manuales y nativos, reintentos, cambios de fuente, audio, excepciones en iframes, Shadow DOM, modos de visualización y cambios de configuración.

## Organización

- `content.js` lee `chrome.storage.sync` desde el mundo aislado y controla los atributos usados por el CSS.
- `main-world.js` intercepta las APIs de reproducción y observa los medios. Recibe las preferencias mediante un `MessagePort`, transferido al arrancar y consumido antes de que los listeners de la página lo reciban. Cambiar los atributos de `<html>` no cambia el estado de bloqueo.
- `content.css` contiene las reglas para ocultar reproductores.
- `popup.js` y `popup.html` gestionan las preferencias.
- `tests/autoplay.test.cjs` contiene las regresiones.

El código en `MAIN` comparte entorno con el sitio. Estas medidas impiden los bypass comprobados en las pruebas, pero no constituyen una frontera de seguridad frente a una página que modifique otras APIs nativas.
