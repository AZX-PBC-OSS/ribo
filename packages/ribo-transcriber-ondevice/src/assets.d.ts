/**
 * @file Ambient declaration for Vite's `?url` asset imports.
 *
 * Only the opt-in `transcribe.manual.ts` uses this — it imports the WAV test clip as a served URL
 * (`import wav from "../testdata/…wav?url"`). Vite resolves `?url` to the emitted asset path; `tsc`
 * needs this declaration to type it, since this package does not pull in `vite/client`.
 */
declare module "*.wav?url" {
  const url: string;
  export default url;
}
