import { builtinModules } from "node:module";
import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default {
  input: "src/plugin.ts",
  output: {
    file: "dev.akira.codex-limit-tracker.sdPlugin/bin/plugin.js",
    format: "cjs",
    sourcemap: true,
  },
  external(id) {
    return builtins.has(id);
  },
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
  ],
};
