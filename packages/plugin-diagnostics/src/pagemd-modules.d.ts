// Types for @pagemd/validate (pagemd-common, phase C8; plain JavaScript, no type files of its own). Only what
// plugin-diagnostics calls is declared. Source: pagemd-common packages/validate/src (index.js, run.js, diagnostic.js).
// The resolver's types (Ports, FileSystem, …) are declared in style-pagemd's pagemd-modules.d.ts.

declare module '@pagemd/validate' {
  import type { Ports } from '@pagemd/resolver';

  export type Severity = 'error' | 'warning' | 'info';

  /** Where a problem is: a file that isn't the document, a 0-based line of the document, the folders looked in. */
  export interface Where {
    file?: string;
    line?: number;
    searched?: string[];
  }

  export interface Diagnostic {
    severity: Severity;
    /** meta | profile | template | layout | styles | syntax | assets */
    level: string;
    code: string;
    message: string;
    where?: Where;
  }

  export interface ValidationResult {
    diagnostics: Diagnostic[];
    /** The profile has a `validation` setting (false: at most a frontmatter or profile error). */
    enabled: boolean;
    strict: boolean;
    profileId: string | null;
  }

  export interface ValidateOptions {
    profile?: string;
    profileOverride?: string;
    cliPath?: string | null;
    strict?: boolean;
  }

  export const LEVELS: readonly string[];
  export function validate(input: { path: string | null; text: string }, options: ValidateOptions, ports: Ports): Promise<ValidationResult>;
  export function passes(diagnostics: Diagnostic[], strict?: boolean): boolean;
}
