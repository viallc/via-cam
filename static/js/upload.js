const MAX_MB = 25;
const allowedTypes = ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'];

function showProgress(msg){
  const up = document.getElementById('uploadProgressWrap'); if(!up) return;
  document.getElementById('upMsg').textContent = msg || 'Uploading…';
  document.getElementById('bar').style.width = '0%';
  up.style.display = 'flex';
}
function setProgress(p){ const b=document.getElementById('bar'); if(b) b.style.width = Math.max(0, Math.min(100, p)) + '%'; }
function hideProgress(){ const up = document.getElementById('uploadProgressWrap'); if(up) up.style.display = 'none'; }

async function enhancedUpload(projectId){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = allowedTypes.join(',');
  inp.multiple = true; // Enable multiple file selection
  inp.onchange = async () => {
    const files = Array.from(inp.files);
    if(!files.length) return;
    
    // Process multiple files
    await uploadMultipleFiles(projectId, files);
  };
  inp.click();
}

async function uploadMultipleFiles(projectId, files) {
  // Validate all files first
  const validFiles = [];
  for(const file of files) {
    if(!allowedTypes.includes(file.type)) {
      alert(`File "${file.name}" has invalid format. Use JPG/PNG/WebP/HEIC.`);
      continue;
    }
    if(file.size > MAX_MB * 1024 * 1024) {
      alert(`File "${file.name}" exceeds ${MAX_MB} MB limit.`);
      continue;
    }
    validFiles.push(file);
  }
  
  if(!validFiles.length) {
    alert('No valid files to upload.');
    return;
  }
  
  showProgress(`Preparing to upload ${validFiles.length} file(s)...`);
  
  let successCount = 0;
  let failCount = 0;
  
  // Upload files one by one to avoid overwhelming the server
  for(let i = 0; i < validFiles.length; i++) {
    const file = validFiles[i];
    const fileProgress = Math.round(((i + 1) / validFiles.length) * 100);
    
    try {
      showProgress(`Uploading ${i + 1}/${validFiles.length}: ${file.name}`);
      await uploadSingleFile(projectId, file, (p) => {
        // Calculate overall progress: previous files + current file progress
        const overallProgress = Math.round((i / validFiles.length * 100) + (p / validFiles.length));
        setProgress(overallProgress);
      });
      successCount++;
    } catch(error) {
      console.error(`Failed to upload ${file.name}:`, error);
      failCount++;
    }
  }
  
  hideProgress();
  
  // Show results
  if(successCount > 0) {
    if(failCount > 0) {
      alert(`Upload completed! ${successCount} files uploaded successfully, ${failCount} failed.`);
    } else {
      alert(`All ${successCount} files uploaded successfully!`);
    }
    location.reload(); // Refresh to show new photos
  } else {
    alert('All uploads failed. Please try again.');
  }
}

async function uploadSingleFile(projectId, file, onProgress) {
  // Try S3 presigned first
  try {
    const pres = await fetch('/api/photos/presign', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ project_id: projectId, filename: file.name, content_type: file.type })
    }).then(r=>r.json());
    
    if(!pres || !pres.upload_url) throw new Error(pres && pres.error ? pres.error : 'No presigned URL');

    await xhrPut(pres.upload_url, file, file.type, onProgress);

    const author = window.currentUserEmail || 'Uploader';
    const today = new Date().toISOString().slice(0,10);
    const reg = await fetch('/api/photos/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ project_id: projectId, s3_key: pres.s3_key, author, date: today })
    }).then(r=>r.json());
    
    if(!reg.ok) throw new Error(reg.error || 'register failed');
    return;
  } catch(err) {
    console.warn('S3 failed for', file.name, ', trying local upload:', err);
  }

  // Fallback: upload to server
  const fd = new FormData();
  fd.append('project_id', projectId);
  fd.append('file', file, file.name);
  const res = await xhrPost('/api/photos/local_upload', fd, onProgress);
  if(!res.ok) throw new Error(res.error || 'local upload failed');
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