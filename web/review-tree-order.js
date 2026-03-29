function formatReviewNumber(index, totalFiles) {
  const width = String(Math.max(1, totalFiles)).length;
  return String(index + 1).padStart(width, "0");
}

function withReviewPrefix(segment, index, totalFiles) {
  return `${formatReviewNumber(index, totalFiles)} · ${segment}`;
}

function splitPath(path) {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function buildDirectoryReviewIndices(paths) {
  const directoryReviewIndices = new Map();

  paths.forEach((path, index) => {
    const segments = splitPath(path);
    let currentPath = "";

    segments.slice(0, -1).forEach((segment) => {
      currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
      const previousIndex = directoryReviewIndices.get(currentPath);
      if (previousIndex == null || index < previousIndex) {
        directoryReviewIndices.set(currentPath, index);
      }
    });
  });

  return directoryReviewIndices;
}

export function buildReviewTreePath(path, index, totalFiles, directoryReviewIndices) {
  const segments = splitPath(path);
  let currentPath = "";

  return segments
    .map((segment, segmentIndex) => {
      currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
      const reviewIndex = segmentIndex === segments.length - 1 ? index : (directoryReviewIndices.get(currentPath) ?? index);
      return withReviewPrefix(segment, reviewIndex, totalFiles);
    })
    .join("/");
}

export function compareReviewTreePaths(a, b) {
  return a.localeCompare(b);
}

export function createReviewTreePaths(paths) {
  const directoryReviewIndices = buildDirectoryReviewIndices(paths);
  const totalFiles = paths.length;

  return paths.map((path, index) => buildReviewTreePath(path, index, totalFiles, directoryReviewIndices));
}
