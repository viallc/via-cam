const MAX_MB = 25;
const allowedTypes = ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'];

function showProgress(msg){
  document.getElementById('upMsg').textContent = msg || 'Subiendo…';
  document.getElementById('bar').style.width = '0%';
  document.getElementById('uploadProgressWrap').style.display = 'flex';
}
function setProgress(p){ document.getElementById('bar').style.width = Math.max(0, Math.min(100, p)) + '%'; }
function hideProgress(){ document.getElementById('uploadProgressWrap').style.display = 'none'; }

async function enhancedUpload(projectId){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = allowedTypes.join(',');
  inp.onchange = async () => {
    const file = inp.files[0];
    if(!file) return;

    // Validation
    if(!allowedTypes.includes(file.type)){
      alert('Formato no permitido. Usa JPG/PNG/WebP/HEIC.');
      return;
    }
    if(file.size > MAX_MB * 1024 * 1024){
      alert('El archivo excede ' + MAX_MB + ' MB.');
      return;
    }

    // Try S3 presigned
    try{
      showProgress('Obteniendo URL de subida segura…');
      const pres = await fetch('/api/photos/presign', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ project_id: projectId, filename: file.name, content_type: file.type })
      }).then(r=>r.json());

      if(!pres || !pres.upload_url) throw new Error(pres && pres.error ? pres.error : 'No presigned URL');

      showProgress('Subiendo a S3…');
      await xhrPut(pres.upload_url, file, file.type, p => setProgress(p));

      showProgress('Registrando en base…');
      const author = 'Uploader';
      const today = new Date().toISOString().slice(0,10);
      const reg = await fetch('/api/photos/register', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ project_id: projectId, s3_key: pres.s3_key, author, date: today })
      }).then(r=>r.json());
      if(!reg.ok) throw new Error(reg.error || 'register failed');

      hideProgress();
      location.reload();
      return;
    }catch(err){
      console.warn('Falla S3, probando carga local:', err);
    }

    // Fallback local
    try{
      showProgress('Subiendo al servidor…');
      const fd = new FormData();
      fd.append('project_id', projectId);
      fd.append('file', file, file.name);
      const res = await xhrPost('/api/photos/local_upload', fd, p => setProgress(p));
      if(!res.ok) throw new Error(res.error || 'local upload failed');
      hideProgress();
      location.reload();
    }catch(err){
      hideProgress();
      alert('Error en subida local: '+err.message);
    }
  };
  inp.click();
}

function xhrPut(url, file, contentType, onProgress){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    xhr.upload.onprogress = (e)=>{ if(e.lengthComputable) onProgress(Math.round((e.loaded/e.total)*100)); };
    xhr.onload = ()=>{ (xhr.status>=200 && xhr.status<300) ? resolve() : reject(new Error('PUT failed '+xhr.status)); };
    xhr.onerror = ()=> reject(new Error('Network error PUT'));
    xhr.send(file);
  });
}

function xhrPost(url, formData, onProgress){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.upload.onprogress = (e)=>{ if(e.lengthComputable) onProgress(Math.round((e.loaded/e.total)*100)); };
    xhr.onload = ()=>{ if(xhr.status>=200 && xhr.status<300){ resolve(JSON.parse(xhr.responseText)); } else { reject(new Error('POST failed '+xhr.status)); } };
    xhr.onerror = ()=> reject(new Error('Network error POST'));
    xhr.send(formData);
  });
}