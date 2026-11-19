export { fragmentFocusScript, FRAGMENT_FOCUS_WAIT_MS };

// Plain text with no hooks, so a Server Component (Next.js's root layout) can render it.

/** @internal How long a link to a place on the page waits for a stylesheet that is loading, at most, in milliseconds. */
const FRAGMENT_FOCUS_WAIT_MS = 2000;

const script =
  // Once a page. Whether the parser ran it, and which element it is, for Ouro check's fragment-focus rule: a copy a script
  // adds runs unheld. The parser runs a script before it parses anything after it, so nothing follows it yet.
  `(function(w,d){if(w.__ouroFragmentFocus)return;var s=d.currentScript,n=s;while(n&&!n.nextSibling)n=n.parentNode;` +
  `w.__ouroFragmentFocus={parsed:d.readyState==="loading"&&!!s&&!n,script:s};` +
  // Only Safari jumps back, so only WebKit (every browser on iOS, and Safari) gets the rest; Chrome and Edge say so.
  `var ua=navigator.userAgent;if(!/AppleWebKit/.test(ua)||/Chrome\\/|Edg\\//.test(ua))return;` +
  // The stylesheets above the script have loaded (or failed): the parser waited for them before it ran the script.
  `var done=new WeakSet,failed=new WeakSet,jump=null,until=0,i,l=d.querySelectorAll('link[rel~="stylesheet"]');for(i=0;i<l.length;i++)done.add(l[i]);` +
  `function pending(x){return !done.has(x)&&x.getAttribute("href")&&!x.disabled&&!/\\balternate\\b/i.test(x.rel)}` +
  `function sheets(){return d.querySelectorAll('link[rel~="stylesheet"]')}` +
  `function loading(){var a=sheets(),j;for(j=0;j<a.length;j++)if(pending(a[j]))return true;return false}` +
  // A stylesheet a deferred or module script added is still loading as the page finishes parsing, when Safari decides:
  // with no sheet yet, or with an @import still loading. Disabled for that moment it doesn't count, and it keeps loading;
  // enabled again a moment later, it applies when it arrives. One that arrived while disabled comes back empty in
  // Safari, so a fresh copy (from the cache, when the sheet allows it) takes its place. Added to the window as the event
  // reaches the document, it runs after every other listener on either, so a stylesheet one of those adds is caught too.
  `function importing(s){try{for(var r=s.cssRules,i=0;i<r.length;i++)if(r[i] instanceof CSSImportRule&&(!r[i].styleSheet||importing(r[i].styleSheet)))return true}catch(e){}return false}` +
  `function renew(x){if(!x.sheet&&!failed.has(x))x.replaceWith(x.cloneNode(true))}` +
  `d.addEventListener("DOMContentLoaded",function(){w.addEventListener("DOMContentLoaded",setAside,{once:true})});` +
  `function setAside(){var a=sheets(),held=[],j;for(j=0;j<a.length;j++)if(pending(a[j])&&(importing(a[j].sheet)||!a[j].sheet)){a[j].disabled=true;held.push(a[j])}` +
  `if(held.length)setTimeout(function(){for(var k=0;k<held.length;k++){var x=held[k];x.disabled=false;` +
  `if(!x.sheet){if(done.has(x))renew(x);else x.addEventListener("load",renew.bind(null,x),{once:true})}}})}` +
  `function here(){return location.href.split("#")[0]}` +
  // A held link goes only while the page is still the one it was clicked on: a router may have moved on meanwhile.
  `function follow(){if(jump&&(!loading()||Date.now()>=until)){var h=jump;jump=null;if(h.split("#")[0]===here())location.assign(h)}}` +
  `function drop(){jump=null}w.addEventListener("popstate",drop);w.addEventListener("hashchange",drop);` +
  // A stylesheet's load or error comes after Safari counts it in, so the jump goes once nothing is loading.
  `function settle(e){if(e.target&&e.target.localName==="link"){done.add(e.target);if(e.type==="error")failed.add(e.target);setTimeout(follow)}}` +
  `d.addEventListener("load",settle,true);d.addEventListener("error",settle,true);` +
  // After the page's own handlers: a router that takes the click has prevented it. Any later link drops a held one.
  `w.addEventListener("click",function(e){var p=e.composedPath(),a,k,h;for(k=0;k<p.length;k++)if((p[k].localName==="a"||p[k].localName==="area")&&typeof p[k].href==="string"&&p[k].hasAttribute("href")){a=p[k];break}` +
  `if(!a)return;jump=null;if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||(a.target&&a.target!=="_self")||a.hasAttribute("download"))return;` +
  // Any "#", the top of the page ("#") too, since Safari scrolls back there as well.
  `h=a.href;if(h.indexOf("#")<0||h.split("#")[0]!==here()||!loading())return;` +
  `e.preventDefault();jump=h;until=Date.now()+${FRAGMENT_FOCUS_WAIT_MS};setTimeout(follow,${FRAGMENT_FOCUS_WAIT_MS})})})(window,document)`;

/**
 * The inline script that keeps a person's focus where it is on a page whose address names a place on it (`#reviews`).
 * Safari jumps back to that place each time a stylesheet loads, until the person scrolls, once the page finished
 * parsing or a link to a place on it was followed while a stylesheet was still loading: on a slow connection, or with a
 * route's CSS that the app's script adds as the page starts. Each jump takes focus from wherever it was: out of an open
 * menu, or a field mid-word. The script stops it. The parser holds an inline script until the stylesheets above it have
 * loaded; a stylesheet a script added that is still loading as parsing ends is set aside for that moment, then carries
 * on; and a link to a place on the page, clicked while a stylesheet is loading, goes there once it has loaded (two
 * seconds at most), unless the page has moved on. Other browsers don't jump back, so it leaves them alone. Put it first
 * in `<body>`, after every stylesheet, as an inline classic script: not a module, and not `async` or `defer`. Painting
 * waits for those stylesheets anyway, so nothing shows later. It is plain text, so a Server Component can render it.
 * Use nothing instead on a page with no stylesheet.
 *
 * @group App setup
 * @see https://ui.ouroboros.bot/docs/ouro-provider
 * @example
 * <html lang="en">
 *   <head>{stylesheets}</head>
 *   <body>
 *     <script dangerouslySetInnerHTML={{ __html: fragmentFocusScript() }} />
 *     {children}
 *   </body>
 * </html>
 * @claim "Safari jumps back to that place each time a stylesheet loads" https://github.com/WebKit/WebKit/blob/33376d8886bfa102fc0164d9081cace28aea10d9/Source/WebCore/dom/Document.cpp verify:urlOk(https://github.com/WebKit/WebKit/blob/33376d8886bfa102fc0164d9081cace28aea10d9/Source/WebCore/dom/Document.cpp) verify:urlOk(https://github.com/WebKit/WebKit/blob/33376d8886bfa102fc0164d9081cace28aea10d9/Source/WebCore/loader/FrameLoader.cpp)
 * @claim "Each jump takes focus from wherever it was" https://github.com/WebKit/WebKit/blob/33376d8886bfa102fc0164d9081cace28aea10d9/Source/WebCore/page/LocalFrameView.cpp verify:urlOk(https://github.com/WebKit/WebKit/blob/33376d8886bfa102fc0164d9081cace28aea10d9/Source/WebCore/page/LocalFrameView.cpp)
 * @claim "The script stops it" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, on a page opened at a place while its stylesheet loads)
 * @claim "The script stops it" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, after a link to a place on the page is followed while a stylesheet loads, and still goes there)
 * @claim "The script stops it" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, after a stylesheet the page's script added was still loading as parsing ended)
 * @claim "is set aside for that moment, then carries on" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, after a stylesheet the page's script added had an @import still loading as parsing ended)
 * @claim "is set aside for that moment, then carries on" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > a stylesheet the page's script added that arrives while set aside still applies, from one link, with one load event)
 * @claim "is set aside for that moment, then carries on" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, after a stylesheet the page's script added had an @import inside an @import still loading as parsing ended)
 * @claim "is set aside for that moment, then carries on" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > keeps focus as later styles load, after a stylesheet the app's own listener added as parsing ended)
 * @claim "unless the page has moved on" registry/ouro/lib/ouro/fragment-focus-script.test.ts verify:testExists(registry/ouro/lib/ouro/fragment-focus-script.test.ts::fragmentFocusScript > drops a held link once the page moves on, or another link is clicked)
 * @claim "Other browsers don't jump back, so it leaves them alone" registry/ouro/lib/ouro/fragment-focus-script.test.ts verify:testExists(registry/ouro/lib/ouro/fragment-focus-script.test.ts::fragmentFocusScript > does nothing in Chrome or Edge, which don't jump back)
 * @claim "two seconds at most" site/e2e/fragment-focus.spec.ts verify:testExists(site/e2e/fragment-focus.spec.ts::fragmentFocusScript > follows a link to a place on the page after two seconds when a stylesheet is still loading)
 */
function fragmentFocusScript(): string {
  return script;
}
