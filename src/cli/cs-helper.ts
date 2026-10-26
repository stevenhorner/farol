import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UsageError } from '../config/load.js'

const MAX_BUFFER = 1024 * 1024 * 1024
const MISSING = 'the .NET SDK (dotnet) is required to analyze a C# project; install it or put it on PATH'

/** dotnet runs without telemetry, first-run messages or a build server left behind. */
export function dotnetEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_UI_LANGUAGE: 'en' }
}

function dotnet(args: readonly string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('dotnet', [...args], { cwd, env: dotnetEnv(), maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && /ENOENT/.test(error.message)) reject(new UsageError(MISSING))
      else if (error) reject(new Error(`dotnet ${args[0] ?? ''} failed: ${stderr.trim() || stdout.trim() || error.message}`, { cause: error }))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/**
 * Builds the C# helper once per source version, SDK version and platform, and returns the path of its assembly. The
 * sources are copied next to the build output, so farol's own directory is never written to. The helper references
 * the Roslyn assemblies of the SDK that builds it: no NuGet package is downloaded.
 */
export async function csHelperAssembly(src: string, sourceHash: string, cacheDir: string): Promise<string> {
  const sdk = (await dotnet(['--version'], src)).trim()
  const key = createHash('sha256').update(`${sourceHash}\n${sdk}\n${process.platform}-${process.arch}`).digest('hex').slice(0, 24)
  const dir = join(cacheDir, 'cs-helper', key)
  const assembly = join(dir, 'bin', 'cshelper.dll')
  if (existsSync(assembly)) return assembly
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(src, 'cs-helper.csproj'), join(dir, 'src', 'cs-helper.csproj'))
  cpSync(join(src, 'src'), join(dir, 'src', 'src'), { recursive: true })
  try {
    // MSBuild looks for Directory.Build.* and response files in every directory above the project: none of them may
    // come into the helper's build, wherever the cache lives.
    await dotnet(['build', join(dir, 'src', 'cs-helper.csproj'), '-c', 'Release', '-o', join(dir, 'bin'), '-v', 'q', '-nologo', '-noAutoResponse', '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:ImportDirectoryPackagesProps=false'], dir)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return assembly
}

/** Runs the helper assembly with the given arguments (stdin: `input`). */
export function runCsHelper(assembly: string, args: readonly string[], cwd: string, input?: string): Promise<string> {
  return dotnet([assembly, ...args], cwd, input)
}
