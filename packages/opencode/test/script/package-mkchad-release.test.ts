import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createManifest, packageMkchadRelease } from "../../script/package-mkchad-release"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })))
})

async function buildDirectory(input: { binary?: boolean; target?: "linux-arm64" | "linux-x64"; version?: string } = {}) {
  const directory = await fs.mkdtemp("/tmp/opencode-mkchad/package-mkchad-release-")
  directories.push(directory)
  await fs.mkdir(path.join(directory, "bin"))
  const target = input.target ?? "linux-x64"
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: `opencode-${target}`,
      version: input.version ?? "1.18.3-mkchad.6",
      os: ["linux"],
      cpu: [target.replace("linux-", "")],
    }),
  )
  if (input.binary !== false) {
    const binary = path.join(directory, "bin/opencode")
    await Bun.write(binary, "#!/bin/sh\nprintf '1.18.3-mkchad.6\\n'\n")
    await fs.chmod(binary, 0o755)
  }
  return directory
}

test("derives Linux glibc manifests and stable assets for both supported architectures", async () => {
  expect(createManifest({ target: "linux-x64", version: "1.18.3-mkchad.6" })).toEqual({
    name: "opencode-ai",
    version: "1.18.3-mkchad.6",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
    bin: { opencode: "./bin/opencode" },
    files: ["bin/opencode"],
    private: true,
  })
  expect(createManifest({ target: "linux-arm64", version: "1.18.3-mkchad.6" })).toMatchObject({
    cpu: ["arm64"],
  })
  const outputDir = await fs.mkdtemp("/tmp/opencode-mkchad/package-mkchad-release-output-")
  directories.push(outputDir)
  const result = await packageMkchadRelease({
    buildDir: await buildDirectory({ target: "linux-arm64" }),
    outputDir,
    target: "linux-arm64",
    version: "1.18.3-mkchad.6",
  })
  expect(path.basename(result.tarball)).toBe("opencode-ai-1.18.3-mkchad.6-linux-arm64.tgz")
})

test("rejects unsupported targets and malformed MkChad versions", () => {
  expect(() => createManifest({ target: "darwin-x64", version: "1.18.3-mkchad.6" })).toThrow("linux-x64")
  expect(() => createManifest({ target: "linux-ppc64", version: "1.18.3-mkchad.6" })).toThrow("linux-x64")
  expect(() => createManifest({ target: "linux-x64", version: "1.18.3" })).toThrow("MkChad version")
})

test("rejects absent binaries and generated-version mismatches before packing", async () => {
  await expect(
    packageMkchadRelease({
      buildDir: await buildDirectory({ binary: false }),
      outputDir: "/tmp/opencode-mkchad",
      target: "linux-x64",
      version: "1.18.3-mkchad.6",
    }),
  ).rejects.toThrow("expected binary")

  await expect(
    packageMkchadRelease({
      buildDir: await buildDirectory({ version: "1.18.3-mkchad.5" }),
      outputDir: "/tmp/opencode-mkchad",
      target: "linux-x64",
      version: "1.18.3-mkchad.6",
    }),
  ).rejects.toThrow("generated version")

  await expect(
    packageMkchadRelease({
      buildDir: await buildDirectory({ target: "linux-x64" }),
      outputDir: "/tmp/opencode-mkchad",
      target: "linux-arm64",
      version: "1.18.3-mkchad.6",
    }),
  ).rejects.toThrow("generated target")
})

test("packs only the manifest and executable payload", async () => {
  const buildDir = await buildDirectory()
  const outputDir = await fs.mkdtemp("/tmp/opencode-mkchad/package-mkchad-release-output-")
  directories.push(outputDir)
  await Bun.write(path.join(buildDir, "unrelated.txt"), "must not be packed")

  const result = await packageMkchadRelease({
    buildDir,
    outputDir,
    target: "linux-x64",
    version: "1.18.3-mkchad.6",
  })

  expect(path.basename(result.tarball)).toBe("opencode-ai-1.18.3-mkchad.6-linux-x64.tgz")
  const packed = Bun.spawn(["tar", "-tzf", result.tarball], { stderr: "pipe", stdout: "pipe" })
  expect((await new Response(packed.stdout).text()).trim().split("\n").sort()).toEqual([
    "package/bin/opencode",
    "package/package.json",
  ])
  expect(await packed.exited).toBe(0)
  const manifest = Bun.spawn(["tar", "-xOzf", result.tarball, "package/package.json"], { stdout: "pipe" })
  expect(JSON.parse(await new Response(manifest.stdout).text())).toEqual(createManifest(result))
  expect(await manifest.exited).toBe(0)
})
