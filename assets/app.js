/* Kofu Yuki Zoo redesign — shared interactions. No localStorage (in-memory only). */
(function(){
  "use strict";
  var $=function(s,c){return (c||document).querySelector(s);};
  var $$=function(s,c){return Array.prototype.slice.call((c||document).querySelectorAll(s));};

  /* ---- search/route index (relative links work from site root) ---- */
  var INDEX=[
    {t:"ホーム Home",u:"index.html",k:"home top trang chủ"},
    {t:"ご案内・アクセス Guide / Access",u:"guide.html",k:"hours fees 料金 開園時間 access map 園内マップ 交通 駐車場"},
    {t:"開園時間・料金 Hours & Fees",u:"guide.html#fees",k:"料金 fee 320 開園時間 hours"},
    {t:"園内マップ Park Map",u:"guide.html#parkmap",k:"map 地図"},
    {t:"交通アクセス Transport",u:"guide.html#access",k:"access 電車 車 bus train"},
    {t:"動物園からのお願い Requests",u:"guide.html#requests",k:"rules etiquette お願い"},
    {t:"入園料の減額・免除 Fee exemption",u:"guide.html#exempt",k:"免除 減額 申請 RTF"},
    {t:"動物取扱業登録 Registration",u:"guide.html#registration",k:"registration 登録"},
    {t:"動物たちの紹介 Animals",u:"animals.html",k:"animals ゾウ ライオン ペンギン フラミンゴ 哺乳類 鳥類 は虫類 動画"},
    {t:"Zoom Up",u:"zoomup.html",k:"zoom up 広報こうふ archive 年"},
    {t:"なぜなぜBOX Why Box",u:"naze.html",k:"q&a question 質問 research 研究"},
    {t:"ニュース News",u:"news.html",k:"news ニュース お知らせ event"},
    {t:"動物園を応援しよう Support",u:"support.html",k:"support donation furusato ふるさと納税 応援"},
    {t:"Foreign Language 外国語",u:"language.html",k:"language english 中文 한국어 translation 翻訳"},
    {t:"文字サイズ・色合いの変更 Display settings",u:"settings.html",k:"font size color contrast 文字 色合い accessibility"},
    {t:"サイトマップ Sitemap",u:"sitemap.html",k:"sitemap"}
  ];

  /* ---- header scroll shadow ---- */
  var header=$(".site-header");
  if(header){window.addEventListener("scroll",function(){header.classList.toggle("scrolled",window.scrollY>4);},{passive:true});}

  /* ---- mobile drawer ---- */
  var drawer=$("#drawer"), backdrop=$("#drawerBackdrop"), navToggle=$("#navToggle");
  function openDrawer(){if(!drawer)return;drawer.classList.add("open");backdrop.classList.add("open");drawer.setAttribute("aria-hidden","false");navToggle.setAttribute("aria-expanded","true");var f=drawer.querySelector("a,button");if(f)f.focus();}
  function closeDrawer(){if(!drawer)return;drawer.classList.remove("open");backdrop.classList.remove("open");drawer.setAttribute("aria-hidden","true");navToggle.setAttribute("aria-expanded","false");}
  if(navToggle){navToggle.addEventListener("click",openDrawer);}
  if(backdrop){backdrop.addEventListener("click",closeDrawer);}
  var dx=$("#drawerClose"); if(dx){dx.addEventListener("click",closeDrawer);}

  /* ---- carousel ---- */
  $$(".carousel").forEach(function(car){
    var slides=$$(".slide",car), dots=$$(".carousel__bar button",car), i=0, timer=null, playing=true;
    function show(n){slides.forEach(function(s,k){s.classList.toggle("active",k===n);if(dots[k])dots[k].setAttribute("aria-selected",k===n);});i=n;}
    function next(){show((i+1)%slides.length);}
    function prev(){show((i-1+slides.length)%slides.length);}
    function start(){stop();if(!window.matchMedia("(prefers-reduced-motion:reduce)").matches){timer=setInterval(next,5000);playing=true;upd();}}
    function stop(){if(timer){clearInterval(timer);timer=null;}playing=false;upd();}
    function upd(){var b=$(".carousel__stop",car);if(b)b.textContent=playing?"❚❚ STOP":"▶ PLAY";}
    var nb=$(".next",car),pb=$(".prev",car),sb=$(".carousel__stop",car);
    if(nb)nb.addEventListener("click",function(){next();start();});
    if(pb)pb.addEventListener("click",function(){prev();start();});
    if(sb)sb.addEventListener("click",function(){playing?stop():start();});
    dots.forEach(function(d,k){d.addEventListener("click",function(){show(k);start();});});
    car.addEventListener("mouseenter",function(){if(timer){clearInterval(timer);timer=null;}});
    car.addEventListener("mouseleave",function(){if(playing)start();});
    show(0);start();
  });

  /* ---- font-size & contrast settings (persisted via localStorage; applies live to <html>) ---- */
  var root=document.documentElement;
  window.KZ_applyFontScale=function(v){
    if(v==="normal") {
      root.removeAttribute("data-fontscale");
      try { localStorage.removeItem("kz_fontscale"); } catch(e) {}
    } else {
      root.setAttribute("data-fontscale",v);
      try { localStorage.setItem("kz_fontscale",v); } catch(e) {}
    }
  };
  window.KZ_applyContrast=function(v){
    if(v==="high") {
      root.setAttribute("data-contrast","high");
      try { localStorage.setItem("kz_contrast","high"); } catch(e) {}
    } else if(v==="dark") {
      root.setAttribute("data-contrast","dark");
      try { localStorage.setItem("kz_contrast","dark"); } catch(e) {}
    } else {
      root.removeAttribute("data-contrast");
      try { localStorage.removeItem("kz_contrast"); } catch(e) {}
    }
  };
  // Load persisted settings on startup
  try {
    var savedFont=localStorage.getItem("kz_fontscale");
    if(savedFont) window.KZ_applyFontScale(savedFont);
    var savedContrast=localStorage.getItem("kz_contrast");
    if(savedContrast) window.KZ_applyContrast(savedContrast);
  } catch(e){}

  // utility-bar quick toggles
  $$("[data-fontstep]").forEach(function(b){b.addEventListener("click",function(){
    var order=["normal","large","xlarge"],cur=root.getAttribute("data-fontscale")||"normal";
    var ni=(order.indexOf(cur)+1)%order.length;window.KZ_applyFontScale(order[ni]);toast("文字サイズ: "+order[ni]);
  });});
  $$("[data-contrasttoggle]").forEach(function(b){b.addEventListener("click",function(){
    var cur=root.getAttribute("data-contrast")||"normal";
    var next="normal";
    if(cur==="normal")next="high";
    else if(cur==="high")next="dark";
    window.KZ_applyContrast(next);
    var labels={"normal":"標準の色合い","high":"高コントラスト","dark":"ダークモード"};
    toast(labels[next]);
  });});

  /* settings form page */
  var sf=$("#settingsForm");
  if(sf){
    try {
      var savedFont=localStorage.getItem("kz_fontscale")||"normal";
      var f_radio=sf.querySelector('input[name=fontsize][value='+savedFont+']');
      if(f_radio) f_radio.checked=true;
      var savedContrast=localStorage.getItem("kz_contrast")||"normal";
      var c_radio=sf.querySelector('input[name=contrast][value='+savedContrast+']');
      if(c_radio) c_radio.checked=true;
    } catch(e){}

    sf.addEventListener("submit",function(e){e.preventDefault();
      var fs=(sf.querySelector('input[name=fontsize]:checked')||{}).value||"normal";
      var ct=(sf.querySelector('input[name=contrast]:checked')||{}).value||"normal";
      window.KZ_applyFontScale(fs);window.KZ_applyContrast(ct);toast("設定を適用しました");
    });
    var rb=$("#settingsReset");
    if(rb)rb.addEventListener("click",function(){window.KZ_applyFontScale("normal");window.KZ_applyContrast("normal");
      var n=sf.querySelector('input[name=fontsize][value=normal]');if(n)n.checked=true;
      var c=sf.querySelector('input[name=contrast][value=normal]');if(c)c.checked=true;toast("標準に戻しました");});
  }

  /* ---- read aloud (SpeechSynthesis) ---- */
  var reading=false;
  function readAloud(){
    var synth=window.speechSynthesis;
    if(!synth){toast("お使いの環境は音声読み上げに対応していません");return;}
    if(reading){synth.cancel();reading=false;toast("読み上げを停止しました");return;}
    var main=$("#main")||document.body;
    var text=(main.innerText||main.textContent||"").replace(/\s+/g," ").trim().slice(0,4000);
    var u=new SpeechSynthesisUtterance(text);u.lang="ja-JP";u.rate=1;
    u.onend=function(){reading=false;};
    synth.cancel();synth.speak(u);reading=true;toast("音声読み上げを開始しました");
  }
  $$("[data-readaloud]").forEach(function(b){b.addEventListener("click",readAloud);});
  if(window.speechSynthesis){
    window.addEventListener("beforeunload",function(){window.speechSynthesis.cancel();});
  }

  /* ---- toast ---- */
  var toastEl;
  function toast(msg){
    if(!toastEl){toastEl=document.createElement("div");toastEl.className="toast";toastEl.setAttribute("role","status");toastEl.setAttribute("aria-live","polite");document.body.appendChild(toastEl);}
    toastEl.textContent=msg;toastEl.classList.add("show");
    clearTimeout(toastEl._t);toastEl._t=setTimeout(function(){toastEl.classList.remove("show");},2200);
  }
  window.KZ_toast=toast;

  /* ---- search overlay & command palette ---- */
  function buildResults(listEl,q){
    var query=(q||"").toLowerCase().trim();
    var items=INDEX.filter(function(it){return !query||(it.t+" "+it.k).toLowerCase().indexOf(query)>-1;});
    if(!items.length){listEl.innerHTML='<li class="hint">該当する項目がありません</li>';return;}
    listEl.innerHTML=items.map(function(it,n){return '<li><a href="'+it.u+'"'+(n===0?' class="active"':'')+'>'+it.t+'</a></li>';}).join("");
  }
  function wireOverlay(overlay,input,list){
    if(!overlay)return;
    function open(){overlay.classList.add("open");buildResults(list,"");input.value="";setTimeout(function(){input.focus();},30);}
    function close(){overlay.classList.remove("open");}
    overlay._open=open;overlay._close=close;
    input.addEventListener("input",function(){buildResults(list,input.value);});
    input.addEventListener("keydown",function(e){
      var links=$$("a",list),idx=links.findIndex(function(a){return a.classList.contains("active");});
      if(e.key==="ArrowDown"){
        e.preventDefault();
        if(idx>=0)links[idx].classList.remove("active");
        var nextLink=links[Math.min(idx+1,links.length-1)];
        if(nextLink){nextLink.classList.add("active");nextLink.scrollIntoView({block:"nearest"});}
      }
      else if(e.key==="ArrowUp"){
        e.preventDefault();
        if(idx>=0)links[idx].classList.remove("active");
        var prevLink=links[Math.max(idx-1,0)];
        if(prevLink){prevLink.classList.add("active");prevLink.scrollIntoView({block:"nearest"});}
      }
      else if(e.key==="Enter"){var a=list.querySelector("a.active");if(a){e.preventDefault();window.location.href=a.getAttribute("href");}}
      else if(e.key==="Escape"){close();}
    });
    overlay.addEventListener("click",function(e){if(e.target===overlay)close();});
  }
  var searchOverlay=$("#searchOverlay");
  wireOverlay(searchOverlay,$("#searchInput"),$("#searchResults"));
  $$("[data-search]").forEach(function(b){b.addEventListener("click",function(){if(searchOverlay)searchOverlay._open();});});

  var palette=$("#palette");
  wireOverlay(palette,$("#paletteInput"),$("#paletteResults"));
  document.addEventListener("keydown",function(e){
    if((e.metaKey||e.ctrlKey)&&(e.key==="k"||e.key==="K")){e.preventDefault();if(palette)palette._open();}
    if(e.key==="Escape"){if(palette&&palette.classList.contains("open"))palette._close();if(searchOverlay&&searchOverlay.classList.contains("open"))searchOverlay._close();closeDrawer();}
  });

  /* ---- map zoom dialog ---- */
  $$("[data-mapzoom]").forEach(function(el){
    el.addEventListener("click",function(){
      var dlg=$("#"+el.getAttribute("data-mapzoom"));
      if(dlg&&dlg.showModal){dlg.showModal();}
    });
  });
  $$("dialog.mapdlg [data-dlgclose]").forEach(function(b){b.addEventListener("click",function(){b.closest("dialog").close();});});

  /* ---- form validation (support / generic) ---- */
  $$("form[data-validate]").forEach(function(f){
    f.addEventListener("submit",function(e){
      var ok=true;
      $$("[required]",f).forEach(function(inp){
        if(!inp.value.trim()){ok=false;inp.setAttribute("aria-invalid","true");}else{inp.removeAttribute("aria-invalid");}
        if(inp.type==="email"&&inp.value&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inp.value)){ok=false;inp.setAttribute("aria-invalid","true");}
      });
      if(!ok){e.preventDefault();toast("入力内容をご確認ください");}
      else{e.preventDefault();toast("送信ありがとうございます（デモ）");f.reset();}
    });
  });
})();
