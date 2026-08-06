// Tenant reservado del super-admin de plataforma. Está excluido de las listas de
// clientes, de la consola de operación y —desde la feature 28— del emparejamiento
// de canales: una sesión creada aquí queda doblemente invisible.
//
// Vive en su propio archivo para que módulos que no deben depender de
// PlatformModule (waha, waba) puedan importarlo sin ciclos.
export const PLATFORM_TENANT_ID = 'platform';
