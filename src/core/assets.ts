/** public/ 下静态资源的绝对地址（Capacitor 与浏览器都适用） */
export const asset = (p: string) => new URL(p, document.baseURI).href;
