/**
 * Minimal ambient declaration for `@supabase/supabase-js`.
 *
 * The generated backend setup files (src/integrations/supabase/*) import this
 * SDK, but the package is intentionally NOT installed: the H2 coordinator talks
 * to PostgREST with native server-side fetch, so no runtime dependency is
 * needed. This declaration only satisfies the typechecker for those generated
 * files. If the SDK is ever installed, delete this file — the real types take
 * over automatically.
 */
declare module "@supabase/supabase-js" {
  export type SupabaseClientOptions = any;
  export type SupabaseClient<Database = any, Schema = any, Extra = any> = any;
  export type Session = any;
  export type User = any;
  export type AuthChangeEvent = string;

  export const createClient: any;
}

