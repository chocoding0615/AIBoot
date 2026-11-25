import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MOCK_DRIVE_FILES = Object.freeze([
  {
    id: '1kepco202611electric',
    name: '2026-11_한국전력_전기요금_청구서.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-11-20T09:15:00.000Z',
    size: 245800,
    webViewLink: 'https://drive.google.com/file/d/1kepco202611electric/view',
    taskRef: 'fixed:electric',
    category: '고정비',
  },
  {
    id: '1water202611bill',
    name: '2026-11_상하수도사업소_수도요금_고지서.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-11-18T11:20:00.000Z',
    size: 189200,
    webViewLink: 'https://drive.google.com/file/d/1water202611bill/view',
    taskRef: 'fixed:water',
    category: '고정비',
  },
  {
    id: '1kttelecom202611',
    name: '2026-11_KT_기업통신_청구내역서.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-11-22T14:40:00.000Z',
    size: 312000,
    webViewLink: 'https://drive.google.com/file/d/1kttelecom202611/view',
    taskRef: 'fixed:kt',
    category: '고정비',
  },
  {
    id: '1welfare2026points',
    name: '2026_복지포인트_지급_및_사용현황.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    modifiedTime: '2026-11-24T16:00:00.000Z',
    size: 524000,
    webViewLink: 'https://drive.google.com/file/d/1welfare2026points/view',
    taskRef: 'welfare:points',
    category: '복지',
  },
  {
    id: '1leasecontracthq',
    name: '본사사옥_임대차계약서_2026.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-01-10T10:00:00.000Z',
    size: 1450000,
    webViewLink: 'https://drive.google.com/file/d/1leasecontracthq/view',
    taskRef: 'contracts:lease',
    category: '계약',
  },
  {
    id: '1corpcards202611',
    name: '2026-11_법인카드_지출증빙_영수증철.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-11-25T08:30:00.000Z',
    size: 890000,
    webViewLink: 'https://drive.google.com/file/d/1corpcards202611/view',
    taskRef: 'general:receipts',
    category: '공용비',
  },
]);

export class WorkspaceDriveService {
  constructor(options = {}) {
    this.gdriveBin = options.gdriveBin || 'gdrive';
    this.useCli = options.useCli !== false;
  }

  async search({ q = '', limit = 20, type = null } = {}) {
    const query = String(q || '').trim().toLowerCase();

    // 1. Try live gdrive CLI if enabled
    if (this.useCli) {
      try {
        const args = ['readonly'];
        if (query) {
          args.push('search', '--name-contains', query, '--max', String(limit), '--json');
        } else {
          args.push('ls', '--max', String(limit), '--json');
        }
        const { stdout } = await execFileAsync(this.gdriveBin, args, { timeout: 4000, windowsHide: true });
        const parsed = JSON.parse(stdout || '[]');
        if (Array.isArray(parsed) && parsed.length > 0) {
          const liveItems = parsed.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            size: f.size || 0,
            webViewLink: f.mimeType === 'application/vnd.google-apps.folder'
              ? `https://drive.google.com/drive/folders/${f.id}`
              : `https://drive.google.com/file/d/${f.id}/view`,
            isLive: true,
          }));
          return { items: liveItems, total: liveItems.length, source: 'live' };
        }
      } catch (err) {
        // Fallback to catalog
      }
    }

    // 2. Fallback to corporate documents catalog
    let filtered = MOCK_DRIVE_FILES;
    if (query) {
      filtered = filtered.filter(
        (f) =>
          f.name.toLowerCase().includes(query) ||
          (f.category && f.category.toLowerCase().includes(query)) ||
          (f.taskRef && f.taskRef.toLowerCase().includes(query))
      );
    }
    if (type) {
      filtered = filtered.filter((f) => f.mimeType.includes(type) || (type === 'pdf' && f.name.endsWith('.pdf')));
    }
    const sliced = filtered.slice(0, Number(limit) || 20);
    return {
      items: sliced,
      total: filtered.length,
      source: 'catalog',
    };
  }

  async resolve(ref) {
    const key = String(ref || '').trim().toLowerCase();
    const found = MOCK_DRIVE_FILES.find(
      (f) =>
        f.taskRef.toLowerCase() === key ||
        f.name.toLowerCase().includes(key) ||
        f.id.toLowerCase() === key
    );
    if (found) {
      return {
        resolved: true,
        id: found.id,
        name: found.name,
        link: found.webViewLink,
        mimeType: found.mimeType,
        category: found.category,
      };
    }
    return {
      resolved: false,
      name: ref,
      link: null,
    };
  }
}
