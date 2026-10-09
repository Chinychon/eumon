/** Interface text on generated pages. Page copy itself comes from the template, written in the page language. */
export type PageLabels = {
  home: string;
  guides: string;
  details: string;
  faq: string;
  related: string;
  lastUpdated: string;
  options: (count: number) => string;
  hubTitle: (site: string) => string;
  noGuides: string;
  notFound: string;
  retired: string;
  browseGuides: string;
  goTo: (site: string) => string;
  /** The opening line of a WhatsApp message from a page about `topic`; the reference code follows it. */
  whatsappHello: (topic: string) => string;
};

const LABELS: Record<string, PageLabels> = {
  en: {
    home: "Home", guides: "Guides", details: "Details", faq: "Frequently asked questions", related: "Related", lastUpdated: "Last updated",
    options: (count) => `${count} ${count === 1 ? "option" : "options"}`, hubTitle: (site) => `${site} guides`, noGuides: "No guides are published yet.",
    notFound: "We couldn’t find that page.", retired: "This page has been retired.", browseGuides: "Browse all guides", goTo: (site) => `go to ${site}`,
    whatsappHello: (topic) => `Hi, I would like to ask about ${topic}`,
  },
  id: {
    home: "Beranda", guides: "Panduan", details: "Detail", faq: "Pertanyaan yang sering diajukan", related: "Terkait", lastUpdated: "Terakhir diperbarui",
    options: (count) => `${count} pilihan`, hubTitle: (site) => `Panduan ${site}`, noGuides: "Belum ada panduan yang diterbitkan.",
    notFound: "Halaman tidak ditemukan.", retired: "Halaman ini sudah tidak tersedia.", browseGuides: "Lihat semua panduan", goTo: (site) => `kunjungi ${site}`,
    whatsappHello: (topic) => `Halo, saya ingin bertanya tentang ${topic}`,
  },
  ms: {
    home: "Utama", guides: "Panduan", details: "Butiran", faq: "Soalan lazim", related: "Berkaitan", lastUpdated: "Kemas kini terakhir",
    options: (count) => `${count} pilihan`, hubTitle: (site) => `Panduan ${site}`, noGuides: "Belum ada panduan diterbitkan.",
    notFound: "Halaman tidak dijumpai.", retired: "Halaman ini tidak lagi tersedia.", browseGuides: "Lihat semua panduan", goTo: (site) => `pergi ke ${site}`,
    whatsappHello: (topic) => `Hai, saya ingin bertanya tentang ${topic}`,
  },
  zh: {
    home: "首页", guides: "指南", details: "详情", faq: "常见问题", related: "相关内容", lastUpdated: "最后更新",
    options: (count) => `${count} 个选项`, hubTitle: (site) => `${site} 指南`, noGuides: "暂无已发布的指南。",
    notFound: "找不到该页面。", retired: "该页面已下线。", browseGuides: "浏览所有指南", goTo: (site) => `前往 ${site}`,
    whatsappHello: (topic) => `您好，我想咨询${topic}`,
  },
  th: {
    home: "หน้าแรก", guides: "คู่มือ", details: "รายละเอียด", faq: "คำถามที่พบบ่อย", related: "ที่เกี่ยวข้อง", lastUpdated: "อัปเดตล่าสุด",
    options: (count) => `${count} ตัวเลือก`, hubTitle: (site) => `คู่มือ ${site}`, noGuides: "ยังไม่มีคู่มือที่เผยแพร่",
    notFound: "ไม่พบหน้านี้", retired: "หน้านี้ถูกนำออกแล้ว", browseGuides: "ดูคู่มือทั้งหมด", goTo: (site) => `ไปที่ ${site}`,
    whatsappHello: (topic) => `สวัสดีค่ะ ขอสอบถามเกี่ยวกับ ${topic}`,
  },
  vi: {
    home: "Trang chủ", guides: "Hướng dẫn", details: "Chi tiết", faq: "Câu hỏi thường gặp", related: "Liên quan", lastUpdated: "Cập nhật lần cuối",
    options: (count) => `${count} lựa chọn`, hubTitle: (site) => `Hướng dẫn của ${site}`, noGuides: "Chưa có hướng dẫn nào được xuất bản.",
    notFound: "Không tìm thấy trang.", retired: "Trang này không còn khả dụng.", browseGuides: "Xem tất cả hướng dẫn", goTo: (site) => `đến ${site}`,
    whatsappHello: (topic) => `Xin chào, tôi muốn hỏi về ${topic}`,
  },
};

/** Languages with translated interface labels, for settings pickers. Others fall back to English labels. */
export const PAGE_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "zh", name: "中文" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
];

export function labelsFor(language: string | undefined): PageLabels {
  return LABELS[(language ?? "en").toLowerCase().split("-")[0]!] ?? LABELS.en!;
}

/** English name of a language code, for model prompts ("Write in Indonesian"). */
export function languageName(language: string | undefined): string {
  const code = (language ?? "en").toLowerCase();
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A safe value for `<html lang>`: the configured BCP 47 tag, or `en`. */
export function htmlLang(language: string | undefined): string {
  return language && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(language) ? language : "en";
}
