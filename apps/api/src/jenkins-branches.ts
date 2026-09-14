import {
  QUICK_JOB_NAME,
  buildSourceBranch,
  type BuildBranchCatalog,
  type BuildBranchChoice,
} from "@relay-qa-hub/upload-contract";

const fail = (): never => {
  throw new Error("BUILD_BRANCHES_UNAVAILABLE");
};
export function parseBranchChoices(
  raw: unknown,
  configuration: "Debug" | "Release",
): BuildBranchChoice[] {
  if (
    !Array.isArray(raw) ||
    !Array.isArray(raw[0]) ||
    !Array.isArray(raw[1]) ||
    raw[0].length !== raw[1].length
  )
    return fail();
  const choices: BuildBranchChoice[] = [];
  for (const original of raw[0]) {
    if (typeof original !== "string" || original.length > 400) return fail();
    const label = original.replace(/:selected$/, ""),
      value = label.split(" | ")[0]!;
    if (value === "unavailable") continue;
    try {
      if (buildSourceBranch(value, configuration) !== value) return fail();
    } catch {
      return fail();
    }
    const match =
      value === "auto"
        ? / → ([A-Za-z0-9_./-]+) \| ([a-f0-9]{10,40})$/.exec(label)
        : /^([A-Za-z0-9_./-]+) \| ([a-f0-9]{10,40})$/.exec(label);
    if (
      !match ||
      buildSourceBranch(match[1], configuration) !== match[1] ||
      choices.some((c) => c.value === value)
    )
      return fail();
    choices.push({ value, label, resolvedBranch: match[1]!, revision: match[2]! });
  }
  if (!choices.length) return fail();
  return choices;
}

/** Read the installed Active Choices helper through its own UI query contract.
 * Session cookies and Stapler handles stay local; no build/configuration POST is made. */
export async function readBuildBranches(
  fetcher: typeof fetch,
  origin: string,
  authorization: string,
): Promise<BuildBranchCatalog> {
  const cookies = new Map<string, string>();
  const signal = AbortSignal.timeout(60_000);
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(origin + path, {
      ...init,
      headers: {
        authorization,
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...Object.fromEntries(new Headers(init.headers)),
      },
      redirect: "manual",
      signal,
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!,
        i = pair.indexOf("=");
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response;
  };
  const body = async (r: Response, allowForm = false) => {
    if (!r.ok && !(allowForm && r.status === 405)) {
      await r.body?.cancel();
      return fail();
    }
    const text = await r.text();
    if (text.length > 2_000_000) return fail();
    return text;
  };
  const crumb = JSON.parse(await body(await request("/crumbIssuer/api/json"))) as {
    crumbRequestField: string;
    crumb: string;
  };
  if (!/^[\w-]+$/.test(crumb.crumbRequestField) || typeof crumb.crumb !== "string") return fail();
  const html = await body(
    await request(`/job/${encodeURIComponent(QUICK_JOB_NAME)}/build?delay=0sec`),
    true,
  );
  const proxy = html.match(/data-name="源码分支"[^>]*data-proxy-name="([A-Za-z0-9_]+)"/)?.[1];
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) =>
    m[1]!.replaceAll("&amp;", "&"),
  );
  const scriptPath = scripts.find((p) => p.includes(`var=${proxy}&`));
  if (
    !proxy ||
    !scriptPath ||
    !/^\/\$stapler\/bound\/script\/\$stapler\/bound\/[a-f0-9-]+\?var=[A-Za-z0-9_]+&methods=doUpdate,getChoicesForUI$/.test(
      scriptPath,
    )
  )
    return fail();
  const script = await body(await request(scriptPath));
  const binding = script.match(
    /makeStaplerProxy\('(\/\$stapler\/bound\/[a-f0-9-]+)','([a-f0-9]+)',\['doUpdate','getChoicesForUI'\]\)/,
  );
  if (!binding) return fail();
  const result: BuildBranchCatalog = {
    checkedAt: new Date().toISOString(),
    Debug: [],
    Release: [],
  };
  for (const configuration of ["Debug", "Release"] as const) {
    const headers = {
      "content-type": "application/x-stapler-method-invocation;charset=UTF-8",
      Crumb: binding[2]!,
      [crumb.crumbRequestField]: crumb.crumb,
    };
    await body(
      await request(binding[1] + "/doUpdate", {
        method: "POST",
        headers,
        body: JSON.stringify([
          `打包用途=Android ${configuration} · ${configuration === "Debug" ? "APK、完整热更" : "APK、AAB、完整热更"}`,
        ]),
      }),
    );
    result[configuration] = parseBranchChoices(
      JSON.parse(
        await body(
          await request(binding[1] + "/getChoicesForUI", { method: "POST", headers, body: "[]" }),
        ),
      ),
      configuration,
    );
  }
  return result;
}
