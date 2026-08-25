// Flat ESLint config for the Next.js app. Scoped to real defects: unused
// bindings, empty catch blocks and React hook rules. FE-18 recorded that no
// ESLint was installed at all, so the six `eslint-disable` comments in this
// tree were inert.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "**/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly",
        localStorage: "readonly", sessionStorage: "readonly", fetch: "readonly",
        console: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly", WebSocket: "readonly", AbortController: "readonly",
        ResizeObserver: "readonly", MutationObserver: "readonly", IntersectionObserver: "readonly",
        URL: "readonly", URLSearchParams: "readonly", Notification: "readonly",
        matchMedia: "readonly", location: "readonly", history: "readonly", alert: "readonly",
        confirm: "readonly", performance: "readonly", queueMicrotask: "readonly",
        HTMLElement: "readonly", HTMLDivElement: "readonly", HTMLCanvasElement: "readonly",
        HTMLInputElement: "readonly", HTMLTextAreaElement: "readonly", HTMLSelectElement: "readonly",
        HTMLButtonElement: "readonly", Event: "readonly", MouseEvent: "readonly",
        TouchEvent: "readonly", KeyboardEvent: "readonly", WheelEvent: "readonly",
        PointerEvent: "readonly", Blob: "readonly", File: "readonly", FileReader: "readonly",
        CustomEvent: "readonly", DOMRect: "readonly", Image: "readonly", process: "readonly",
        structuredClone: "readonly", crypto: "readonly", btoa: "readonly", atob: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly", ServiceWorkerRegistration: "readonly",
        PushSubscription: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly",
        RequestInit: "readonly", ScrollBehavior: "readonly", SVGSVGElement: "readonly",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-undef": "off",
    },
  },
  {
    // Service worker: a ServiceWorkerGlobalScope, not a window.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly", clients: "readonly", caches: "readonly",
        fetch: "readonly", console: "readonly", Response: "readonly",
      },
    },
  },
);
