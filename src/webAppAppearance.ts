/** Match browser/Home Screen chrome to the explicit in-app theme, not the OS
 * preference. Also called before React mounts by index.html's bootstrap. */
export function syncWebAppAppearance(theme: 'dark'|'light', doc:Document=document) {
  const color=theme==='light'?'#fafaf8':'#151615';
  doc.documentElement.dataset.theme=theme;
  doc.documentElement.style.colorScheme=theme;
  doc.documentElement.style.backgroundColor=color;
  const meta=(name:string,content:string)=>{
    let element=doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    if(!element){element=doc.createElement('meta');element.name=name;doc.head.append(element);}
    element.content=content;
  };
  meta('theme-color',color);
  meta('apple-mobile-web-app-status-bar-style',theme==='light'?'default':'black');
}
