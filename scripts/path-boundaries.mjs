import path from "node:path";

export function isWithinOrEqual(candidate, parent, pathApi = path) {
  const relativePath = pathApi.relative(parent, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  );
}

export function pathsOverlap(first, second, pathApi = path) {
  return isWithinOrEqual(first, second, pathApi) || isWithinOrEqual(second, first, pathApi);
}
