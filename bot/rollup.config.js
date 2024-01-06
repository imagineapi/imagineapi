import typescript from "rollup-plugin-typescript2";
import { defineConfig } from "rollup";
import { obfuscator } from "rollup-obfuscator";

export default defineConfig([
  {
    input: "src/consumer.ts",
    output: {
      // sourcemap: true,
      dir: "dist",
    },
    watch: {
      clearScreen: true,
    },
    // plugins: [typescript(), execute("node obfuscate.cjs", { once: true })],
    plugins: [
      typescript(),
      obfuscator({
        global: false, // must be false to use exclude
        exclude: [
          "src/playwright-utils/browser-eval/**",
          "src/playwright-utils/browser-eval/agent.ts",
        ],
      }),
    ],
  },
]);
