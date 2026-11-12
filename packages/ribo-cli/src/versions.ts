/**
 * The versions the inspect report carries, resolved at bundle time (design §7 /
 * ADR 0037): the published bin answers "which CLI, which core" without reading
 * `node_modules` at run time, because both `package.json` files are inlined into
 * the single-file bundle. Running from source (the unit tests) reads the same
 * two files through the workspace, so one mechanism serves both.
 */
import corePackageJson from "@azx/ribo-core/package.json" with { type: "json" };
import cliPackageJson from "../package.json" with { type: "json" };

/** The version of the `@azx/ribo-cli` package the bundle was built from. */
export const cliVersion: string = cliPackageJson.version;

/** The version of `@azx/ribo-core` the measures were computed with. */
export const coreVersion: string = corePackageJson.version;
