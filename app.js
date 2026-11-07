"use strict";
// Supabase認証、マニュアル管理、検索、タグ、編集履歴。
let categories = [];
let manuals = [];
let allTags = [];
let manualTags = new Map();
const categoryIcons = {"商品制作":"✿","接客・販売":"♙","配達・納品":"▣","店舗運営":"⌂","花の管理":"♧","社内ルール":"☷","その他":"•"};
const formatDate = value => value ? new Date(value).toLocaleDateString("ja-JP") : "";

const $ = id => document.getElementById(id);
let selectedCategory = "";
let client = null;
let currentUser = null;
let recoveryMode = false;
let editingId = null;
let editingVersion = null;
let viewingId = null;
let detailReturnView = "homeView";
let selectedPhotos = [];
let existingPhotos = [];
let removedPhotoIds = new Set();
const IMAGE_BUCKET = "manual-image";
const MAX_PHOTOS = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const DOCUMENT_BUCKET = "manual-files";
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MIMES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
let selectedDocuments = [];
let existingDocuments = [];
let removedDocumentIds = new Set();
function documentExtension(fileName) {
  return String(fileName || "").split(".").pop().toLowerCase();
}
function documentStorageKey(row) {
  return row.storage_path.slice(`${DOCUMENT_BUCKET}/`.length);
}
async function fetchDocuments(manualId) {
  const {data,error} = await client.from("manual_files")
    .select("id,file_name,storage_path,mime_type,file_size,created_at")
    .eq("manual_id",manualId).order("created_at",{ascending:true});
  if (error) throw error;
  return (data || []).filter(row => row.storage_path?.startsWith(`${DOCUMENT_BUCKET}/`) &&
    Object.hasOwn(DOCUMENT_MIMES,documentExtension(row.file_name)));
}
function renderDocumentEditor() {
  const target = $("documentPreview");
  target.replaceChildren();
  const kept = existingDocuments.filter(row => !removedDocumentIds.has(row.id));
  $("documentCount").textContent = `${kept.length + selectedDocuments.length} / ${MAX_DOCUMENTS}ファイル`;
  function addItem(name,size,onRemove,label) {
    const item=document.createElement("div"); item.className="document-item";
    const info=document.createElement("span");
    info.textContent=`📄 ${name}（${(size/1024/1024).toFixed(2)}MB）`;
    const button=document.createElement("button"); button.type="button";
    button.className="photo-remove"; button.textContent=label;
    button.addEventListener("click",onRemove);
    item.append(info,button); target.append(item);
  }
  kept.forEach(row => addItem(row.file_name,row.file_size || 0,()=>{
    removedDocumentIds.add(row.id); renderDocumentEditor();
  },"削除予定にする"));
  selectedDocuments.forEach((file,index)=>addItem(file.name,file.size,()=>{
    selectedDocuments.splice(index,1); renderDocumentEditor();
  },"選択を取り消す"));
}
function chooseDocuments(event) {
  const files=[...event.target.files]; event.target.value="";
  if (files.some(file => !Object.hasOwn(DOCUMENT_MIMES,documentExtension(file.name)) ||
      file.size===0 || file.size>MAX_DOCUMENT_BYTES)) {
    alert("PDF・Word（.pdf / .doc / .docx）のファイルを1件10MB以内で選択してください。"); return;
  }
  const kept=existingDocuments.filter(row=>!removedDocumentIds.has(row.id)).length;
  if (kept+selectedDocuments.length+files.length>MAX_DOCUMENTS) {
    alert("添付書類は最大5ファイルです。"); return;
  }
  selectedDocuments.push(...files); renderDocumentEditor();
}
async function uploadDocuments(manualId) {
  for (const file of selectedDocuments) {
    const ext=documentExtension(file.name);
    const key=`${manualId}/${crypto.randomUUID()}.${ext}`;
    const mime=DOCUMENT_MIMES[ext];
    const {error:storageError}=await client.storage.from(DOCUMENT_BUCKET)
      .upload(key,file,{contentType:mime,upsert:false});
    if (storageError) throw storageError;
    const {error:dbError}=await client.from("manual_files").insert({
      manual_id:manualId,file_name:file.name,storage_path:`${DOCUMENT_BUCKET}/${key}`,
      mime_type:mime,file_size:file.size,uploaded_by:currentUser.id
    });
    if (dbError) {
      await client.storage.from(DOCUMENT_BUCKET).remove([key]);
      throw dbError;
    }
  }
}
async function deleteSelectedDocuments() {
  for (const row of existingDocuments.filter(x=>removedDocumentIds.has(x.id))) {
    const {data,error}=await client.from("manual_files").delete().eq("id",row.id).select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("添付書類の削除権限がありません（manual_files DELETE）。");
    const {error:storageError}=await client.storage.from(DOCUMENT_BUCKET).remove([documentStorageKey(row)]);
    if (storageError) console.warn("Storageに未参照の書類が残りました",storageError);
  }
}
async function renderDetailDocuments(manualId) {
  const target=$("detailDocuments"); target.textContent="添付書類を読み込んでいます…";
  try {
    const rows=await fetchDocuments(manualId);
    if (viewingId!==manualId) return;
    target.replaceChildren();
    if (!rows.length) { target.textContent="添付書類はありません。"; return; }
    for (const row of rows) {
      const item=document.createElement("div"); item.className="document-item";
      const name=document.createElement("span"); name.textContent=`📄 ${row.file_name}`;
      const button=document.createElement("button"); button.type="button";
      button.className="photo-remove";
      button.textContent=documentExtension(row.file_name)==="pdf" ? "開く / 保存" : "ダウンロード";
      button.addEventListener("click",async()=>{
        button.disabled=true;
        try {
          const ext=documentExtension(row.file_name);
          const options=ext==="pdf" ? undefined : {download:row.file_name};
          const {data,error}=await client.storage.from(DOCUMENT_BUCKET)
            .createSignedUrl(documentStorageKey(row),120,options);
          if (error) throw error;
          const link=document.createElement("a");
          link.href=data.signedUrl; link.target="_blank"; link.rel="noopener noreferrer";
          document.body.append(link); link.click(); link.remove();
        } catch(error) { console.error(error); alert("ファイルを開けませんでした。\n"+error.message); }
        finally {button.disabled=false;}
      });
      item.append(name,button); target.append(item);
    }
  } catch(error) {
    if (viewingId===manualId) target.textContent="添付書類を取得できませんでした。";
    console.error(error);
  }
}


async function fetchPhotos(manualId) {
  const { data, error } = await client.from("manual_files")
    .select("id,file_name,storage_path,mime_type,file_size,created_at")
    .eq("manual_id", manualId).in("mime_type", [...IMAGE_TYPES])
    .order("created_at", { ascending: true });
  if (error) throw error;
  // 旧データの別バケットのファイルを誤って操作しないため、写真用パスだけを扱います。
  return (data || []).filter(x => x.storage_path?.startsWith(`${IMAGE_BUCKET}/`));
}
function imageStorageKey(row) {
  return row.storage_path.slice(`${IMAGE_BUCKET}/`.length);
}
function renderPhotoEditor() {
  const preview = $("photoPreview");
  preview.replaceChildren();
  const kept = existingPhotos.filter(x => !removedPhotoIds.has(x.id));
  $("photoCount").textContent = `${kept.length + selectedPhotos.length} / ${MAX_PHOTOS}枚`;
  for (const photo of kept) {
    const item = document.createElement("div"); item.className = "photo-tile";
    const img = document.createElement("img"); img.alt = photo.file_name || "登録済み写真";
    // 非公開バケットのため公開URLは使用せず、署名付きURLを非同期取得。
    client.storage.from(IMAGE_BUCKET).createSignedUrl(imageStorageKey(photo), 3600)
      .then(({data,error}) => { if (!error && item.isConnected) img.src = data.signedUrl; })
      .catch(console.error);
    const remove = document.createElement("button"); remove.type="button";
    remove.textContent="削除予定にする"; remove.className="photo-remove";
    remove.addEventListener("click", () => { removedPhotoIds.add(photo.id); renderPhotoEditor(); });
    item.append(img,remove); preview.append(item);
  }
  selectedPhotos.forEach((photo,index) => {
    const item = document.createElement("div"); item.className="photo-tile";
    const img = document.createElement("img"); img.alt=photo.name;
    const url = URL.createObjectURL(photo);
    img.src=url; img.addEventListener("load",()=>URL.revokeObjectURL(url),{once:true});
    const remove=document.createElement("button"); remove.type="button";
    remove.textContent="選択を取り消す"; remove.className="photo-remove";
    remove.addEventListener("click",()=>{selectedPhotos.splice(index,1);renderPhotoEditor();});
    item.append(img,remove); preview.append(item);
  });
}
function choosePhotos(event) {
  const files=[...event.target.files];
  event.target.value="";
  if (files.some(f=>!IMAGE_TYPES.has(f.type) || f.size>MAX_IMAGE_BYTES || f.size===0)) {
    alert("JPEG・PNG・WebP形式で、1枚5MB以内の写真を選択してください。"); return;
  }
  const kept=existingPhotos.filter(x=>!removedPhotoIds.has(x.id)).length;
  if (kept+selectedPhotos.length+files.length>MAX_PHOTOS) {
    alert("写真は1マニュアルにつき最大5枚です。"); return;
  }
  selectedPhotos.push(...files); renderPhotoEditor();
}
async function renderDetailPhotos(manualId) {
  const target=$("detailImages"); target.replaceChildren();
  const photos=await fetchPhotos(manualId);
  if (viewingId!==manualId) return;
  for (const photo of photos) {
    const {data,error}=await client.storage.from(IMAGE_BUCKET)
      .createSignedUrl(imageStorageKey(photo), 3600);
    if (error) { console.error("写真表示エラー",error); continue; }
    const link=document.createElement("a"); link.href=data.signedUrl;
    link.target="_blank"; link.rel="noopener noreferrer";
    const img=document.createElement("img"); img.src=data.signedUrl;
    img.alt=photo.file_name || "マニュアルの写真"; img.loading="lazy";
    link.append(img); target.append(link);
  }
}
function openDetailPhotos(id) {
  $("detailImages").textContent="写真を読み込んでいます…";
  renderDetailPhotos(id).catch(error=>{
    console.error(error); $("detailImages").textContent="写真を表示できませんでした。";
  });
}
async function uploadPhotos(manualId) {
  const uploaded=[];
  for (const file of selectedPhotos) {
    const ext={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[file.type];
    const key=`${manualId}/${crypto.randomUUID()}.${ext}`;
    const {error:storageError}=await client.storage.from(IMAGE_BUCKET)
      .upload(key,file,{contentType:file.type,upsert:false});
    if (storageError) throw storageError;
    const {error:dbError}=await client.from("manual_files").insert({
      manual_id:manualId,file_name:file.name,storage_path:`${IMAGE_BUCKET}/${key}`,
      mime_type:file.type,file_size:file.size,uploaded_by:currentUser.id
    });
    if (dbError) {
      await client.storage.from(IMAGE_BUCKET).remove([key]);
      throw dbError;
    }
    uploaded.push(key);
  }
  return uploaded;
}
async function deleteSelectedPhotos() {
  for (const photo of existingPhotos.filter(x=>removedPhotoIds.has(x.id))) {
    // 先にDB行を削除。失敗時はStorageに触れず安全に停止する。
    const {data,error}=await client.from("manual_files").delete()
      .eq("id",photo.id).select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("写真の削除権限を確認してください（manual_files DELETE）。");
    const {error:storageError}=await client.storage.from(IMAGE_BUCKET).remove([imageStorageKey(photo)]);
    if (storageError) console.warn("Storageに未参照の写真が残りました",storageError);
  }
}


function show(view) {
  ["loginView", "homeView", "categoryView", "detailView", "editorView", "resetView"].forEach(id => {
    $(id).classList.toggle("hidden", id !== view);
  });
  $("logoutButton").classList.toggle("hidden", !currentUser || view === "resetView");
  const homeButton = $("globalHomeButton");
  if (homeButton) homeButton.classList.toggle("hidden", !currentUser || view === "loginView" || view === "resetView" || view === "homeView");
  window.scrollTo(0, 0);
}
function renderCategories() {
  const container = $("categories");
  container.replaceChildren();
  for (const item of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category" + (selectedCategory === item.name ? " active" : "");
    button.setAttribute("aria-pressed", String(selectedCategory === item.name));
    const icon = document.createElement("span");
    icon.className = "symbol";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.icon;
    const label = document.createElement("span");
    label.textContent = item.name;
    button.append(icon, label);
    button.addEventListener("click", () => {
      selectedCategory = item.name;
      $("searchInput").value = "";
      renderCategories();
      renderManuals();
      renderCategoryView();
      show("categoryView");
    });
    container.append(button);
  }
}
function searchTerms(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ja").trim().split(/\s+/u).filter(Boolean);
}
function matchesSearch(manual, keyword) {
  const tags = manualTags.get(manual.id) || [];
  const searchable = [manual.title, manual.summary, manual.body, manual.category, ...tags]
    .join(" ").normalize("NFKC").toLocaleLowerCase("ja");
  return searchTerms(keyword).every(term => searchable.includes(term));
}
function rankedManuals(items, keyword) {
  const terms = searchTerms(keyword);
  if (!terms.length) return items;
  const score = m => {
    const title = String(m.title || "").normalize("NFKC").toLocaleLowerCase("ja");
    const tags = (manualTags.get(m.id) || []).join(" ").normalize("NFKC").toLocaleLowerCase("ja");
    return terms.reduce((n, t) => n + (title.includes(t) ? 10 : 0) + (tags.includes(t) ? 5 : 0), 0);
  };
  return [...items].sort((a,b) => score(b)-score(a));
}
function normalizeTags(raw) {
  const tags = String(raw || "").split(/[,、，\n]+/u).map(t => t.normalize("NFKC").trim())
    .filter(Boolean);
  return [...new Set(tags)];
}
function renderTagSuggestions() {
  const list = $("tagSuggestions");
  if (!list) return;
  list.replaceChildren();
  for (const tag of allTags) {
    const option = document.createElement("option");
    option.value = tag;
    list.append(option);
  }
}
function renderDetailTags(manual) {
  let el = $("detailTags");
  if (!el) {
    el = document.createElement("p"); el.id = "detailTags";
    el.style.marginTop = "12px";
    $("detailMeta").after(el);
  }
  el.textContent = (manualTags.get(manual.id) || []).map(t => `#${t}`).join("  ");
}
async function loadTags() {
  const {data,error} = await client.from("manual_tags").select("manual_id,tag").limit(10000);
  if (error) throw error;
  manualTags = new Map();
  for (const item of data || []) {
    const current = manualTags.get(item.manual_id) || [];
    current.push(item.tag); manualTags.set(item.manual_id,current);
  }
  allTags = [...new Set((data || []).map(x => x.tag))].sort((a,b)=>a.localeCompare(b,"ja"));
  renderTagSuggestions();
}
async function replaceTags(id, tags) {
  const old = manualTags.get(id) || [];
  const toAdd = tags.filter(t => !old.includes(t));
  const toDelete = old.filter(t => !tags.includes(t));
  if (toAdd.length) {
    const {error} = await client.from("manual_tags").insert(toAdd.map(tag => ({manual_id:id,tag})));
    if (error) throw error;
  }
  if (toDelete.length) {
    const {error} = await client.from("manual_tags").delete().eq("manual_id",id).in("tag",toDelete);
    if (error) throw error;
  }
}

function renderManuals() {
  const keyword = $("searchInput").value.trim().toLocaleLowerCase("ja");
  const filtered = rankedManuals(manuals.filter(m => matchesSearch(m, keyword)), keyword);
  $("listTitle").textContent = keyword ? `検索結果（${filtered.length}件）` : "最近の更新";
  const list = $("manualList");
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "該当するマニュアルはありません。";
    list.append(empty);
    return;
  }
  for (const manual of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manual-row";
    const title = document.createElement("span");
    title.className = "name";
    title.textContent = "▤  " + manual.title;
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = manual.date + " ›";
    button.append(title, date);
    button.addEventListener("click", () => {
      $("detailTitle").textContent = manual.title;
      $("detailMeta").textContent = manual.category + " / " + manual.date;
      $("detailBody").textContent = manual.body || "";
      renderDetailTags(manual);
      viewingId = manual.id;
      openDetailPhotos(manual.id);
      renderDetailDocuments(manual.id);
      detailReturnView = $("categoryView").classList.contains("hidden") ? "homeView" : "categoryView";
      $("revisionPanel").classList.add("hidden");
      $("detailEditButton").classList.remove("hidden");
      show("detailView");
    });
    list.append(button);
  }
}


// カテゴリーごとの独立した一覧画面（既存HTMLに追加して利用）
function renderCategoryView() {
  const heading = $("categoryHeading");
  const list = $("categoryManualList");
  if (!heading || !list) return;
  heading.textContent = selectedCategory || "カテゴリー";
  list.replaceChildren();
  const keyword = $("categorySearchInput").value.trim().toLocaleLowerCase("ja");
  const filtered = rankedManuals(manuals.filter(m => m.category === selectedCategory && matchesSearch(m, keyword)), keyword);
  $("categoryCount").textContent = `${filtered.length}件のマニュアル`;
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "このカテゴリーに該当するマニュアルはありません。";
    list.append(empty);
    return;
  }
  for (const manual of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "manual-row";
    const title = document.createElement("span");
    title.className = "name";
    title.textContent = "▤  " + manual.title;
    const date = document.createElement("span");
    date.className = "date";
    date.textContent = manual.date + " ›";
    button.append(title, date);
    button.addEventListener("click", () => {
      viewingId = manual.id;
      detailReturnView = "categoryView";
      $("detailTitle").textContent = manual.title;
      $("detailMeta").textContent = manual.category + " / " + manual.date;
      $("detailBody").textContent = manual.body || "";
      renderDetailTags(manual);
      openDetailPhotos(manual.id);
      renderDetailDocuments(manual.id);
      $("revisionPanel").classList.add("hidden");
      $("detailEditButton").classList.remove("hidden");
      show("detailView");
    });
    list.append(button);
  }
}

async function loadManuals() {
  const {data, error} = await client.from("manuals")
    .select("id,title,summary,body,category_id,status,version,updated_at,created_at")
    .order("updated_at", {ascending:false}).limit(500);
  if (error) throw error;
  const names = new Map(categories.map(c => [c.id, c.name]));
  manuals = (data || []).map(m => ({
    ...m,
    category: names.get(m.category_id) || "その他",
    date: formatDate(m.updated_at || m.created_at)
  }));
  await loadTags();
  renderManuals();
  renderCategoryView();
}

async function loadCategories() {
  const {data,error} = await client.from("categories")
    .select("id,name,sort_order").order("sort_order",{ascending:true});
  if (error) throw error;
  categories = (data || []).map(c => ({...c,icon:categoryIcons[c.name] || "▤"}));
  const select = $("categorySelect");
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "カテゴリーを選択";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);
  for (const item of categories) {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = item.name;
    select.append(option);
  }
  renderCategories();
}

async function openEditor(manual = null) {
  const form = $("manualForm");
  form.reset();
  selectedPhotos=[]; removedPhotoIds=new Set(); existingPhotos=[];
  selectedDocuments=[]; removedDocumentIds=new Set(); existingDocuments=[];
  if (manual) {
    try { existingPhotos=await fetchPhotos(manual.id); }
    catch(error) { alert("登録済み写真を取得できません。編集を中止します。\n"+error.message); return; }
  }
  if (manual) {
    try { existingDocuments=await fetchDocuments(manual.id); }
    catch(error) { alert("登録済み書類を取得できません。編集を中止します。\n"+error.message); return; }
  }
  renderPhotoEditor();
  renderDocumentEditor();
  editingId = manual?.id || null;
  editingVersion = manual?.version ?? null;
  $("editorHeading").textContent = manual ? "マニュアルを編集" : "新しいマニュアル";
  $("editorSubmit").textContent = manual ? "変更を保存" : "マニュアルを登録";
  $("tagInput").value = manual ? (manualTags.get(manual.id) || []).join("、") : "";
  if (manual) {
    form.elements.namedItem("title").value = manual.title;
    form.elements.namedItem("category").value = String(manual.category_id ?? "");
    form.elements.namedItem("body").value = manual.body || "";
  }
  show("editorView");
}

async function saveManual(event) {
  event.preventDefault();
  if (!currentUser || !client) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  const body = String(data.get("body") || "").trim();
  const categoryId = Number(data.get("category"));
  const tags = normalizeTags($("tagInput").value);
  if (tags.length > 20 || tags.some(t => t.length > 40)) {
    alert("タグは20個まで、1個40文字以内で入力してください。"); return;
  }
  if (!title || !body || !categories.some(c => c.id === categoryId)) {
    alert("タイトル・カテゴリー・本文を確認してください。");
    return;
  }
  button.disabled = true;
  const keptCount=existingPhotos.filter(x=>!removedPhotoIds.has(x.id)).length;
  if (keptCount+selectedPhotos.length>MAX_PHOTOS) { alert("写真は最大5枚です。"); button.disabled=false; return; }
  const keptDocuments=existingDocuments.filter(x=>!removedDocumentIds.has(x.id)).length;
  if (keptDocuments+selectedDocuments.length>MAX_DOCUMENTS) {
    alert("添付書類は最大5ファイルです。"); button.disabled=false; return;
  }
  let savedId = editingId;
  let mainSaved = false;
  try {
    if (editingId) {
      // 既存のDB関数が、更新と履歴保存を1トランザクションで実行します。
      const { error } = await client.rpc("update_manual", {
        p_id: editingId,
        p_expected_version: editingVersion,
        p_title: title,
        p_summary: manuals.find(m => m.id === editingId)?.summary || "",
        p_body: body,
        p_category_id: categoryId,
        p_status: manuals.find(m => m.id === editingId)?.status || "published"
      });
      if (error) throw error;
      mainSaved = true;
    } else {
      const { data: created, error } = await client.from("manuals").insert({
        title, body, summary: "", category_id: categoryId,
        status: "published", created_by: currentUser.id, updated_by: currentUser.id
      }).select("id").single();
      if (error) throw error;
      savedId = created.id;
      mainSaved = true;
    }
    await replaceTags(savedId, tags);
    await uploadPhotos(savedId);
    await uploadDocuments(savedId);
    await deleteSelectedPhotos();
    await deleteSelectedDocuments();
    const wasEditing = Boolean(editingId);
    const returnToCategory = wasEditing && detailReturnView === "categoryView";
    const savedCategory = categories.find(c => c.id === categoryId)?.name || "";
    await loadManuals();
    editingId = null;
    editingVersion = null;
    form.reset();
    selectedPhotos=[]; existingPhotos=[]; removedPhotoIds=new Set();
    selectedDocuments=[]; existingDocuments=[]; removedDocumentIds=new Set();
    selectedCategory = "";
    $("searchInput").value = "";
    renderCategories();
    renderManuals();
    if (returnToCategory) {
      selectedCategory = savedCategory;
      $("categorySearchInput").value = "";
      renderCategories();
      renderCategoryView();
      show("categoryView");
    } else {
      show("homeView");
    }
    alert(wasEditing ? "変更を保存し、更新履歴を記録しました。" : "マニュアルを保存しました。");
  } catch (error) {
    console.error("マニュアル保存エラー:", error);
    if (mainSaved) {
      alert("マニュアル本文は保存されましたが、タグ・写真・添付書類の保存・削除でエラーが発生しました。\n画面を更新し、タグを確認してください。\n" + (error.message || ""));
    } else if (/Version conflict/i.test(error.message || "")) {
      alert("他のスタッフが先に更新しています。変更内容を控え、ホームに戻って最新版を確認してください。");
    } else {
      alert("保存できませんでした。\n" + (error.message || "エラーの詳細をConsoleで確認してください。"));
    }
  } finally {
    button.disabled = false;
  }
}

async function showRevisions() {
  if (!viewingId || !currentUser) return;
  const {data, error} = await client.from("manual_revisions")
    .select("version,created_at,edited_by,snapshot")
    .eq("manual_id", viewingId).order("version", {ascending:false}).limit(50);
  if (error) { alert("履歴を取得できませんでした。" + error.message); return; }
  const panel = $("revisionPanel");
  panel.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "変更前の履歴";
  panel.append(heading);
  if (!data?.length) {
    const empty = document.createElement("p");
    empty.textContent = "まだ変更履歴はありません。";
    panel.append(empty);
  }
  for (const rev of data || []) {
    const item = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `バージョン ${rev.version} ／ ${formatDate(rev.created_at)}（変更前）`;
    const title = document.createElement("p");
    title.textContent = `タイトル：${rev.snapshot?.title || ""}`;
    const body = document.createElement("p");
    body.style.whiteSpace = "pre-wrap";
    body.textContent = rev.snapshot?.body || "";
    item.append(summary, title, body);
    panel.append(item);
  }
  panel.classList.remove("hidden");
}

async function checkActiveStaff(user) {
  const { data, error } = await client.from("profiles").select("active").eq("id", user.id).single();
  if (error || data?.active !== true) {
    throw new Error("有効な従業員アカウントが確認できません。管理者にお問い合わせください。");
  }
}
async function applySession(session) {
  if (recoveryMode) {
    currentUser = null;
    show("resetView");
    return;
  }
  const user = session?.user;
  if (!user) {
    currentUser = null;
    show("loginView");
    return;
  }
  try {
    await checkActiveStaff(user);
    currentUser = user;
    $("loginMessage").textContent = "";
    show("homeView");
    try {
      await loadCategories();
      await loadManuals();
    } catch (loadError) {
      console.error("データ取得エラー:", loadError);
      $("manualList").textContent = "データを取得できません。SupabaseのRLS設定を確認してください。";
    }
  } catch (error) {
    currentUser = null;
    await client.auth.signOut();
    show("loginView");
    $("loginMessage").textContent = error.message;
  }
}
async function login(event) {
  event.preventDefault();
  if (!client) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  $("loginMessage").textContent = "ログインを確認しています…";
  button.disabled = true;
  try {
    const { data: result, error } = await client.auth.signInWithPassword({
      email: String(data.get("email") || "").trim(),
      password: String(data.get("password") || "")
    });
    if (error) throw error;
    await applySession(result.session);
    form.reset();
  } catch (error) {
    $("loginMessage").textContent = "ログインできませんでした。メールアドレス・パスワード・アカウント設定を確認してください。";
    console.error("ログインエラー:", error);
  } finally {
    button.disabled = false;
  }
}
async function logout() {
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) {
    alert("ログアウトできませんでした。もう一度お試しください。");
    return;
  }
  currentUser = null;
  show("loginView");
}
async function sendResetEmail(event) {
  event.preventDefault();
  if (!client) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const email = String(new FormData(form).get("email") || "").trim();
  button.disabled = true;
  $("recoveryMessage").textContent = "送信しています…";
  try {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: new URL("index.html", window.location.href).href.split("#")[0]
    });
    if (error) throw error;
    $("recoveryMessage").textContent = "登録済みのアドレスであれば、再設定メールが届きます。メールをご確認ください。";
  } catch (error) {
    console.error("再設定メール送信エラー:", error);
    $("recoveryMessage").textContent = "メールを送信できませんでした。時間をおいて再試行してください。";
  } finally {
    button.disabled = false;
  }
}
async function updatePassword(event) {
  event.preventDefault();
  if (!client || !recoveryMode) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  const password = String(data.get("password") || "");
  const confirmation = String(data.get("confirmPassword") || "");
  if (password.length < 8) {
    $("resetMessage").textContent = "パスワードは8文字以上にしてください。";
    return;
  }
  if (password !== confirmation) {
    $("resetMessage").textContent = "確認用パスワードが一致しません。";
    return;
  }
  button.disabled = true;
  $("resetMessage").textContent = "更新しています…";
  try {
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    recoveryMode = false;
    await client.auth.signOut();
    currentUser = null;
    form.reset();
    history.replaceState(null, "", window.location.pathname);
    show("loginView");
    $("loginMessage").textContent = "パスワードを変更しました。新しいパスワードでログインしてください。";
  } catch (error) {
    console.error("パスワード更新エラー:", error);
    $("resetMessage").textContent = "変更できませんでした。再設定メールを新しく発行してやり直してください。";
  } finally {
    button.disabled = false;
  }
}
async function init() {
  renderCategories();
  renderManuals();
  // ログイン中は、どの画面からでもホームに戻れる共通ボタン。
  const homeButton = document.createElement("button");
  homeButton.id = "globalHomeButton";
  homeButton.type = "button";
  homeButton.className = "logout-button hidden";
  homeButton.textContent = "⌂ ホーム";
  homeButton.setAttribute("aria-label", "ホーム画面に戻る");
  homeButton.style.marginLeft = "auto";
  homeButton.style.marginRight = "8px";
  const headerInner = document.querySelector(".header-inner");
  headerInner.insertBefore(homeButton, $("logoutButton"));
  homeButton.addEventListener("click", () => {
    selectedCategory = "";
    detailReturnView = "homeView";
    editingId = null;
    editingVersion = null;
    $("searchInput").value = "";
    renderCategories();
    renderManuals();
    show("homeView");
  });
  const categoryView = document.createElement("section");
  categoryView.id = "categoryView";
  categoryView.className = "view hidden";
  categoryView.innerHTML = `<button class="back" type="button" id="categoryBackButton">← カテゴリー一覧に戻る</button>
    <h2 id="categoryHeading"></h2>
    <p id="categoryCount" class="muted"></p>
    <label class="search-wrap"><span aria-hidden="true">⌕</span>
      <input id="categorySearchInput" type="search" placeholder="このカテゴリー内を検索" aria-label="カテゴリー内を検索"></label>
    <section class="recent"><h2>マニュアル一覧</h2><div id="categoryManualList"></div></section>`;
  $("homeView").after(categoryView);
  $("categoryBackButton").addEventListener("click", () => {
    selectedCategory = "";
    $("categorySearchInput").value = "";
    renderCategories();
    renderManuals();
    show("homeView");
  });
  $("categorySearchInput").addEventListener("input", renderCategoryView);
  $("searchInput").addEventListener("input", () => {
    // ホーム検索は全カテゴリーが対象。カテゴリー選択状態を解除する。
    if (selectedCategory) {
      selectedCategory = "";
      renderCategories();
    }
    renderManuals();
  });
  $("searchInput").addEventListener("search", renderManuals);
  // 既存HTMLに編集・履歴ボタンを追加（index.htmlは変更不要）。
  const detail = $("detailView");
  const edit = document.createElement("button");
  edit.id = "detailEditButton";
  edit.type = "button";
  edit.className = "primary";
  edit.textContent = "このマニュアルを編集";
  edit.addEventListener("click", () => {
    const manual = manuals.find(m => m.id === viewingId);
    if (manual) openEditor(manual);
  });
  const historyButton = document.createElement("button");
  historyButton.type = "button";
  historyButton.className = "back";
  historyButton.textContent = "変更履歴を見る";
  historyButton.addEventListener("click", showRevisions);
  const panel = document.createElement("div");
  panel.id = "revisionPanel";
  panel.className = "hidden";
  detail.append(edit, historyButton, panel);
  $("editorView").querySelector("h2").id = "editorHeading";
  $("manualForm").querySelector('button[type="submit"]').id = "editorSubmit";
  const tagWrap = document.createElement("label");
  tagWrap.textContent = "検索タグ（「、」またはカンマで区切る）";
  const tagInput = document.createElement("input");
  tagInput.id = "tagInput"; tagInput.name = "tags";
  tagInput.type = "text"; tagInput.placeholder = "例：ユリ、水揚げ、水あげ、鮮度管理";
  tagInput.setAttribute("list", "tagSuggestions");
  tagInput.autocomplete = "off";
  const tagList = document.createElement("datalist"); tagList.id = "tagSuggestions";
  const tagHelp = document.createElement("small");
  tagHelp.textContent = "既存のタグを入力すると候補が表示されます。複数タグは「、」で区切ってください。";
  tagWrap.append(tagInput, tagList, tagHelp);
  const submit = $("editorSubmit");
  submit.before(tagWrap);
  $("newButton").addEventListener("click", () => { if (currentUser) openEditor(); });
  document.querySelectorAll("[data-back]").forEach(button =>
    button.addEventListener("click", () => {
      const wasEditing = Boolean(editingId);
      editingId = null;
      editingVersion = null;
      if (button.closest("#detailView") && detailReturnView === "categoryView") {
        renderCategoryView();
        show("categoryView");
      } else if (button.closest("#editorView") && detailReturnView === "categoryView" && wasEditing) {
        renderCategoryView();
        show("categoryView");
      } else {
        show("homeView");
      }
    })
  );
  $("photoInput").addEventListener("change",choosePhotos);
  $("documentInput").addEventListener("change",chooseDocuments);
  $("manualForm").addEventListener("submit", saveManual);
  $("loginForm").addEventListener("submit", login);
  $("logoutButton").addEventListener("click", logout);
  $("recoveryForm").addEventListener("submit", sendResetEmail);
  $("resetForm").addEventListener("submit", updatePassword);
  $("forgotPasswordButton").addEventListener("click", () => {
    $("recoveryPanel").classList.toggle("hidden");
  });

  const config = window.FLOWER_MANUAL_CONFIG;
  if (!config || !config.url || !config.publishableKey ||
      config.url.includes("YOUR_PROJECT_ID") ||
      config.publishableKey === "YOUR_PUBLISHABLE_KEY") {
    show("loginView");
    $("loginMessage").textContent = "config.js にSupabaseの接続情報を設定してください。";
    return;
  }
  if (!window.supabase?.createClient) {
    show("loginView");
    $("loginMessage").textContent = "Supabaseライブラリを読み込めませんでした。ネット接続を確認してください。";
    return;
  }
  client = window.supabase.createClient(config.url, config.publishableKey);
  const params = new URLSearchParams(window.location.hash.slice(1));
  const queryParams = new URLSearchParams(window.location.search);
  const isRecoveryLink = params.get("type") === "recovery" ||
    (params.has("access_token") && params.get("type") === "recovery") ||
    queryParams.has("token_hash") && queryParams.get("type") === "recovery" ||
    queryParams.has("code");
  if (isRecoveryLink) {
    recoveryMode = true;
    show("resetView");
    $("resetMessage").textContent = "再設定リンクを確認しています…";
  }
  client.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryMode = true;
      show("resetView");
      $("resetMessage").textContent = "新しいパスワードを入力してください。";
    } else if (event === "SIGNED_OUT" && !recoveryMode) {
      currentUser = null;
      show("loginView");
    }
  });
  if (queryParams.has("token_hash") && queryParams.get("type") === "recovery") {
    const { error } = await client.auth.verifyOtp({
      token_hash: queryParams.get("token_hash"), type: "recovery"
    });
    if (error) {
      $("resetMessage").textContent = "リンクが無効または期限切れです。再設定メールを再送してください。";
      return;
    }
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    if (recoveryMode) {
      $("resetMessage").textContent = "リンクを確認できませんでした。再設定メールを再送してください。";
    } else {
      show("loginView");
      $("loginMessage").textContent = "ログイン状態を確認できませんでした。";
    }
    return;
  }
  if (recoveryMode) {
    if (!data.session && !queryParams.has("code")) {
      $("resetMessage").textContent = "リンクを確認できませんでした。再設定メールを再送してください。";
    } else {
      $("resetMessage").textContent = "新しいパスワードを入力してください。";
    }
    show("resetView");
    return;
  }
  await applySession(data.session);
}
document.addEventListener("DOMContentLoaded", () => {
  init().catch(error => {
    console.error("初期化エラー:", error);
    show("loginView");
    $("loginMessage").textContent = "アプリの起動に失敗しました。設定とネット接続を確認してください。";
  });
});
