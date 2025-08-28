import { defineConfig } from "vite";

export default defineConfig({
  base: "/Cookers/",
  build: {
    target: "esnext",  // allows top-level await
  },
});
