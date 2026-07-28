#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import { parseArgs } from "util"

const architectures = {
  "linux-x64": "x64",
  "linux-arm64": "arm64",
} as const

export function createManifest(input: { target: string; version: string }) {
  const cpu = architectures[input.target as keyof typeof architectures]
  if (!cpu) throw new Error(`unsupported target ${input.target}; expected linux-x64 or linux-arm64`)
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-mkchad\.(?:0|[1-9]\d*)$/.test(input.version)) {
    throw new Error(`invalid MkChad version ${input.version}`)
  }
  return {
    name: "opencode-ai",
    version: input.version,
    os: ["linux"],
    cpu: [cpu],
    libc: ["glibc"],
    bin: { opencode: "./bin/opencode" },
    files: ["bin/opencode"],
    private: true,
  }
}

export async function packageMkchadRelease(input: {
  buildDir: string
  outputDir: string
  target: string
  version: string
}) {
  const manifest = createManifest(input)
  const binary = path.join(input.buildDir, "bin/opencode")
  const binaryInfo = await fs.stat(binary).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`expected binary is absent: ${binary}`)
    }
    throw error
  })
  if (!binaryInfo.isFile()) throw new Error(`expected binary is not a file: ${binary}`)
  if ((binaryInfo.mode & 0o111) === 0) throw new Error(`expected binary is not executable: ${binary}`)

  const generated = await Bun.file(path.join(input.buildDir, "package.json")).json()
  if (generated.version !== input.version) {
    throw new Error(`generated version ${generated.version ?? "is absent"} does not match ${input.version}`)
  }
  if (
    generated.name !== `opencode-${input.target}` ||
    generated.os?.join(",") !== "linux" ||
    generated.cpu?.join(",") !== manifest.cpu.join(",")
  ) {
    throw new Error(`generated target does not match ${input.target}`)
  }

  const asset = `opencode-ai-${input.version}-${input.target}.tgz`
  const tarball = path.join(input.outputDir, asset)
  await fs.mkdir(input.outputDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(input.outputDir, ".opencode-ai-"))
  try {
    await fs.mkdir(path.join(staging, "bin"))
    await fs.copyFile(binary, path.join(staging, "bin/opencode"))
    await fs.chmod(path.join(staging, "bin/opencode"), binaryInfo.mode)
    await Bun.write(path.join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

    const packed = Bun.spawn(
      ["bun", "pm", "pack", "--filename", tarball, "--ignore-scripts"],
      { cwd: staging, stderr: "pipe", stdout: "pipe" },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(packed.stdout).text(),
      new Response(packed.stderr).text(),
      packed.exited,
    ])
    if (exitCode !== 0) throw new Error(`failed to pack ${asset}: ${stderr.trim() || stdout.trim()}`)

    const contents = Bun.spawn(["tar", "-tzf", tarball], { stderr: "pipe", stdout: "pipe" })
    const [files, tarError, tarExitCode] = await Promise.all([
      new Response(contents.stdout).text(),
      new Response(contents.stderr).text(),
      contents.exited,
    ])
    if (tarExitCode !== 0) throw new Error(`failed to inspect ${asset}: ${tarError.trim()}`)
    if (files.trim().split("\n").sort().join("\n") !== "package/bin/opencode\npackage/package.json") {
      throw new Error(`unexpected packed contents for ${asset}: ${files.trim()}`)
    }
    return { tarball }
  } catch (error) {
    await fs.rm(tarball, { force: true })
    throw error
  } finally {
    await fs.rm(staging, { force: true, recursive: true })
  }
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      "build-dir": { type: "string" },
      "output-dir": { type: "string" },
      target: { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  }).values
  const option = (name: keyof typeof values) => {
    const value = values[name]
    if (!value) throw new Error(`--${name} is required`)
    return value
  }
  const result = await packageMkchadRelease({
    buildDir: option("build-dir"),
    outputDir: option("output-dir"),
    target: option("target"),
    version: option("version"),
  })
  console.log(result.tarball)
}
