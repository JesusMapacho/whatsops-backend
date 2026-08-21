# spec — la parte de backend de cada feature

Un archivo por feature, `NN-slug.md`, plano y sin carpetas de lote: el número ordena y el
lote es metadato. El número es **el de producto**, el mismo que llevan los otros tres
documentos de la misma feature, así que se cita como «la 42» y basta.

Los otros tres viven en `whatsops-spec` (clónalo como hermano de este repo):

| Documento | Dónde | Qué contesta |
|---|---|---|
| Producto | `../whatsops-spec/producto/NN-slug.md` | qué no se puede hacer hoy, y para quién |
| **Contrato** | `../whatsops-spec/contrato/NN-slug.md` | **la frontera**: endpoints, formas, errores, compatibilidad |
| Frontend | `../whatsops-frontend/spec/NN-slug.md` | la pantalla |

**La plantilla y las reglas están en `../whatsops-spec/README.md`.** No se copian aquí: tres
copias de una plantilla son tres plantillas distintas dentro de un año.

Dos que conviene tener presentes al escribir de este lado:

- **Una decisión que solo se justifica por una necesidad de la app no es de esta capa: es de
  la frontera**, y va en el contrato. Aquí se cita, no se vuelve a argumentar.
- **La «Definición de hecho» tiene que comprobarse sin el frontend levantado.** Si no se
  puede, la sección `## Compatibilidad` del contrato está mal: un cambio que rompe necesita un
  paso que acepte las dos formas, porque entre repos no existen los commits atómicos.
