export const RELEASE_PAGE = 'https://github.com/JerryVon39/TIARA/releases';
const RELEASE_API = 'https://api.github.com/repos/JerryVon39/TIARA/releases/latest';
const versionPattern = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function releaseInfo(release, installed) {
  const version = /^v/.test(release?.tag_name) ? release.tag_name : 'v' + release?.tag_name;
  const latestParts = versionPattern.exec(version)?.slice(1).map(Number);
  const installedParts = versionPattern.exec('v' + installed)?.slice(1).map(Number);
  if (!latestParts || !installedParts || release.draft || release.prerelease) throw new Error('无法识别正式发行版本');
  const firstChange = latestParts.findIndex((part, i) => part !== installedParts[i]);
  const uploads = Array.isArray(release.assets) ? release.assets : [];
  const assets = [];
  for (const kind of ['portable', 'ssp']) {
    const name = 'TIARA-' + kind + '-' + version.slice(1) + '.zip';
    const url = RELEASE_PAGE + '/download/' + version + '/' + name;
    const asset = uploads.find(item => item?.name === name && item.browser_download_url === url && item.state === 'uploaded');
    if (asset) assets.push({
      kind, name, url, size: Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null,
      sha256: /^sha256:[a-f\d]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null,
    });
  }
  return { installed, available: version.slice(1), update: firstChange >= 0 && latestParts[firstChange] > installedParts[firstChange],
    url: RELEASE_PAGE + '/tag/' + version, assets };
}

export function sspSnapshotWindow(from) {
  return { from, to: new Date(Date.parse(from) + 6 * 86400000).toISOString().slice(0, 10) };
}

export async function publicRelease(installed, fetchRelease = fetch) {
  const response = await fetchRelease(RELEASE_API, {
    signal: AbortSignal.timeout(6500), redirect: 'error', headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TIARA/' + installed,
    },
  });
  if (!response.ok) {
    if ([403, 429].includes(response.status)) throw new Error('GitHub 暂时限制查询频率');
    if (response.status === 404) throw new Error('GitHub 未返回正式发行版');
    throw new Error('GitHub 暂时无法返回发行信息');
  }
  return releaseInfo(await response.json(), installed);
}
