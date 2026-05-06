import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#faf9f5",
        surface: "#faf9f5",
        "surface-container-lowest": "#ffffff",
        "surface-container-low": "#f4f4f0",
        "surface-container": "#efeeea",
        "surface-container-high": "#e9e8e4",
        "surface-container-highest": "#e3e2df",
        "on-surface": "#1b1c1a",
        "on-surface-variant": "#55433c",
        outline: "#88726b",
        "outline-variant": "#dbc1b8",
        primary: "#944521",
        "primary-container": "#b35c37",
        "primary-fixed": "#ffdbce",
        secondary: "#56642b",
        "secondary-container": "#d6e7a1",
        tertiary: "#7b5508",
        "tertiary-container": "#976d22",
        "tertiary-fixed": "#ffdeae",
      },
      fontFamily: {
        serif: ["Noto Serif SC", "Noto Serif", "serif"],
        sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
      },
      boxShadow: {
        ambient: "0 24px 70px rgba(45, 35, 28, 0.08)",
        float: "0 18px 46px rgba(90, 54, 39, 0.12)",
        soft: "0 10px 30px rgba(45, 35, 28, 0.06)",
      },
    },
  },
  plugins: [],
} satisfies Config;
