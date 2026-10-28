// @vitest-environment jsdom
import{expect,it}from'vitest';
import{readFileSync}from'node:fs';
import{syncWebAppAppearance}from'./webAppAppearance';
it('updates document and browser chrome together when toggling explicit themes',()=>{
 const doc=document.implementation.createHTMLDocument();
 syncWebAppAppearance('light',doc);
 expect(doc.documentElement.dataset.theme).toBe('light');expect(doc.documentElement.style.colorScheme).toBe('light');
 expect(doc.documentElement.style.backgroundColor).toBe('rgb(250, 250, 248)');
 expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fafaf8');
 expect(doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe('default');
 syncWebAppAppearance('dark',doc);syncWebAppAppearance('light',doc);
 expect(doc.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
 expect(doc.querySelectorAll('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveLength(1);
 expect(doc.documentElement.style.backgroundColor).toBe('rgb(250, 250, 248)');
});
it('paints saved light appearance before the application bundle loads',()=>{
 const html=readFileSync('index.html','utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];
 const doc=document.implementation.createHTMLDocument();
 doc.head.innerHTML='<meta name="theme-color" content="#151615"><meta name="apple-mobile-web-app-status-bar-style" content="black">';
 new Function('document','navigator','localStorage',script)(doc,{platform:'iPhone',userAgent:'iPhone',maxTouchPoints:1},{getItem:()=> 'light'});
 expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fafaf8');
 expect(doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe('default');
 expect(doc.documentElement.style.backgroundColor).toBe('rgb(250, 250, 248)');
 const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));
 expect(manifest).not.toHaveProperty('theme_color');expect(manifest.display).toBe('standalone');
});
