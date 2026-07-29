import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  const serverBundle = {
    platform: "node" as const,
    bundle: true,
    format: "cjs" as const,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info" as const,
  };

  await esbuild({
    ...serverBundle,
    entryPoints: ["server/index.ts"],
    outfile: "dist/index.cjs",
  });

  // The OMNI lock TCP ingest is a separate process (server/omni/index.ts): it
  // must be deployable and restartable without touching the web API, so it gets
  // its own bundle rather than being started from dist/index.cjs.
  console.log("building OMNI lock ingest...");
  await esbuild({
    ...serverBundle,
    entryPoints: ["server/omni/index.ts"],
    outfile: "dist/omni.cjs",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
