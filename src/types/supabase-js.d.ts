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
  export type SupabaseClientOptions = Record<string, unknown>;

  // Loose structural type: the generated files are not used at runtime today.
  export type SupabaseClient<Database = unknown, Schema = unknown, Extra = unknown> = {
    [key: string]: any;
  };

  export function createClient<Database = unknown, Schema = unknown, Extra = unknown>(
    supabaseUrl: string,
    supabaseKey: string,
    options?: SupabaseClientOptions,
  ): SupabaseClient<Database, Schema, Extra>;

  export type Session = Record<string, any>;
  export type User = Record<string, any>;
  export type AuthChangeEvent = string;
}
