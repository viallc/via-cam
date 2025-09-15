// Simple Photo Editor Modal for PICK-CAM
// Tools: pencil, rectangle, circle, arrow, text | color | size | undo/redo | save
(function(){
  class PhotoEditor {
    constructor() {
      this.modal = null;
      this.canvas = null;
      this.ctx = null;
      this.baseImage = null;
      this.currentTool = 'pencil';
      this.strokeColor = '#ff0000';
      this.strokeSize = 4;
      this.fontSize = 20;
      this.isDrawing = false;
      this.startX = 0;
      this.startY = 0;
      this.history = [];
      this.redoStack = [];
      this.projectId = null;
      this.photoId = null;
      this.photoSrc = null;
      this.overlayCanvas = null;
      this.overlayCtx = null;
      // Vector items drawn on top of the base image (rect, circle, arrow, text)
      this.items = [];
      this.dragItem = null;
      this.dragOffset = { x: 0, y: 0 };
    }

    open(photoId, projectId, photoSrc) {
      this.photoId = photoId; this.projectId = projectId; this.photoSrc = photoSrc;
      this.createModal();
      this.loadImage(photoSrc);
    }

    createModal() {
      if (this.modal) this.close();
      const el = document.createElement('div');
      el.id = 'photoEditorModal';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10000;display:flex;flex-direction:column;';
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#111;color:#fff;border-bottom:1px solid #222;flex-wrap:wrap;overflow-x:auto;-webkit-overflow-scrolling:touch;position:sticky;top:0;z-index:10001;">
          <button data-tool="select" class="pe-btn">🖱️ Select</button>
          <button data-tool="pencil" class="pe-btn">✏️ Pencil</button>
          <button data-tool="rect" class="pe-btn">▭ Rect</button>
          <button data-tool="circle" class="pe-btn">◯ Circle</button>
          <button data-tool="arrow" class="pe-btn">➡️ Arrow</button>
          <button data-tool="text" class="pe-btn">🔤 Text</button>
          <input id="peText" type="text" placeholder="Type text..." style="margin-left:8px;padding:6px 8px;border-radius:6px;border:1px solid #444;background:#0b0b0b;color:#fff;min-width:180px;" />
          <label style="margin-left:8px;">Color <input id="peColor" type="color" value="#ff0000" style="vertical-align:middle;"></label>
          <label style="margin-left:8px;">Size <select id="peSize"><option>2</option><option selected>4</option><option>6</option><option>8</option><option>12</option></select></label>
          <span style="flex:1"></span>
          <button id="peUndo" class="pe-btn">↩️ Undo</button>
          <button id="peRedo" class="pe-btn">↪️ Redo</button>
          <button id="peCancel" class="pe-btn" style="background:#374151;color:#fff;padding:6px 10px;border-radius:6px;">Cancel</button>
          <button id="peSave" class="pe-btn" style="background:#f97316;color:#fff;padding:6px 14px;border-radius:6px;font-weight:600;">Save</button>
        </div>
        <div style="position:relative;flex:1;display:flex;justify-content:center;align-items:center;background:#000;overflow:auto;padding-bottom:72px;">
          <canvas id="peCanvas" style="max-width:95vw;max-height:80vh;touch-action:none;background:#111"></canvas>
          <canvas id="peOverlay" style="position:absolute;left:0;top:0;background:transparent;pointer-events:none;"></canvas>
        </div>
        <div id="peMobileBar" style="position:fixed;left:0;right:0;bottom:0;background:#111;border-top:1px solid #222;display:flex;gap:10px;justify-content:flex-end;padding:10px 14px;z-index:10002;">
          <button id="peUndo2" class="pe-btn">↩️ Undo</button>
          <button id="peRedo2" class="pe-btn">↪️ Redo</button>
          <button id="peCancel2" class="pe-btn" style="background:#374151;color:#fff;padding:6px 10px;border-radius:6px;">Cancel</button>
          <button id="peSave2" class="pe-btn" style="background:#f97316;color:#fff;padding:6px 14px;border-radius:6px;font-weight:600;">Save</button>
        </div>
      `;
      document.body.appendChild(el);
      this.modal = el;
      this.canvas = el.querySelector('#peCanvas');
      this.overlayCanvas = el.querySelector('#peOverlay');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.overlayCtx = this.overlayCanvas.getContext('2d', { willReadFrequently: true });
      // Ensure text input stays above and interactive
      if (!this.textInput) { this.textInput = el.querySelector('#peText'); }
      if (this.textInput) {
        this.textInput.style.zIndex = '10001';
        this.textInput.style.display = 'none';
        this.textInput.setAttribute('autocomplete','off');
      }
      // Events
      const toolButtons = el.querySelectorAll('.pe-btn[data-tool]');
      const markActive = ()=>{
        toolButtons.forEach(b=>{
          if (b.getAttribute('data-tool') === this.currentTool) {
            b.style.background = '#f97316';
            b.style.color = '#fff';
          } else {
            b.style.background = '';
            b.style.color = '';
          }
        });
      };
      toolButtons.forEach(btn=>{
        btn.addEventListener('click', ()=>{ this.currentTool = btn.getAttribute('data-tool'); markActive(); });
      });
      el.querySelector('#peColor').addEventListener('input', (e)=>{ this.strokeColor = e.target.value; });
      el.querySelector('#peSize').addEventListener('change', (e)=>{ this.strokeSize = parseInt(e.target.value,10)||4; this.fontSize = Math.max(14, this.strokeSize*5); });
      this.textInput = el.querySelector('#peText');
      el.querySelector('#peUndo').addEventListener('click', ()=> this.undo());
      el.querySelector('#peRedo').addEventListener('click', ()=> this.redo());
      el.querySelector('#peCancel').addEventListener('click', ()=> this.close());
      el.querySelector('#peSave').addEventListener('click', ()=> this.save());

      // Mirror actions in bottom mobile bar
      const mb = el.querySelector('#peMobileBar');
      const bind = (sel, fn)=>{ const b = el.querySelector(sel); if (b) b.addEventListener('click', fn); };
      bind('#peUndo2', ()=> this.undo());
      bind('#peRedo2', ()=> this.redo());
      bind('#peCancel2', ()=> this.close());
      bind('#peSave2', ()=> this.save());
      const updateMobileBarVisibility = ()=>{ if (mb) { mb.style.display = (window.innerWidth <= 768) ? 'flex' : 'none'; } };
      updateMobileBarVisibility();
      window.addEventListener('resize', updateMobileBarVisibility);

      // Set initial active tool UI
      markActive();

      // Pointer events
      const down = (e)=>{ e.preventDefault(); const p = this.pos(e); this.saveSnapshot(); this.isDrawing = true; this.startX=p.x; this.startY=p.y; if (this.currentTool==='select'){ const hit=this.hitTest(p.x,p.y); if(hit){ this.dragItem=hit.it; this.dragOffset={ x:p.x-hit.it.x1, y:p.y-hit.it.y1 }; this.isDrawing=false; } else { this.dragItem=null; this.isDrawing=false; } return; } if (this.currentTool==='pencil'){ this.ctx.strokeStyle=this.strokeColor; this.ctx.lineWidth=this.strokeSize; this.ctx.lineCap='round'; this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y);} this.clearOverlay(); if (this.currentTool==='text' && this.textInput){ const r=this.canvas.getBoundingClientRect(); this.textInput.style.position='fixed'; this.textInput.style.left=(r.left+p.x+10)+'px'; this.textInput.style.top=(r.top+p.y-10)+'px'; this.textInput.style.display='block'; this.textInput.value=''; this.textInput.focus(); this.isDrawing=false; } };
      const move = (e)=>{ const p=this.pos(e); if(this.dragItem){ const it=this.dragItem; const w=it.x2-it.x1, h=it.y2-it.y1; it.x1=p.x-this.dragOffset.x; it.y1=p.y-this.dragOffset.y; it.x2=it.x1+w; it.y2=it.y1+h; if(it.type==='text'){ it.x2=it.x1; it.y2=it.y1; } this.redrawAll(); return; } if(!this.isDrawing) return; if(this.currentTool==='pencil'){ this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); } else { this.previewShape(p.x,p.y); } };
      const up = (e)=>{ if(this.dragItem){ this.dragItem=null; this.saveSnapshot(); return; } if(!this.isDrawing) return; const p=this.pos(e); this.isDrawing=false; this.clearOverlay(); if(this.currentTool==='pencil'){ this.ctx.closePath(); } else if(this.currentTool==='rect'){ this.items.push({type:'rect',x1:this.startX,y1:this.startY,x2:p.x,y2:p.y,color:this.strokeColor,size:this.strokeSize}); this.redrawAll(); this.saveSnapshot(); } else if(this.currentTool==='circle'){ this.items.push({type:'circle',x1:this.startX,y1:this.startY,x2:p.x,y2:p.y,color:this.strokeColor,size:this.strokeSize}); this.redrawAll(); this.saveSnapshot(); } else if(this.currentTool==='arrow'){ this.items.push({type:'arrow',x1:this.startX,y1:this.startY,x2:p.x,y2:p.y,color:this.strokeColor,size:this.strokeSize}); this.redrawAll(); this.saveSnapshot(); } };

      // Commit typed text on Enter and keep Text tool active
      this.textInput && this.textInput.addEventListener('keydown', (ev)=>{
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const t = this.textInput.value.trim();
          this.textInput.value = '';
          this.textInput.style.display = 'none';
          if (t) { this.items.push({ type:'text', x1:this.startX, y1:this.startY, x2:this.startX, y2:this.startY, color:this.strokeColor, size:this.strokeSize, text:t }); this.redrawAll(); this.saveSnapshot(); }
          // Keep tool as text for multiple labels
          this.currentTool = 'text';
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          this.textInput.value = '';
          this.textInput.style.display = 'none';
        }
      });
      this.canvas.addEventListener('pointerdown', down, { passive:false });
      this.canvas.addEventListener('pointermove', move, { passive:false });
      window.addEventListener('pointerup', up, { passive:false });
      window.addEventListener('resize', ()=> this.resizeToViewport());
    }

    loadImage(src){
      const img = new Image();
      img.onload = ()=>{
        // Fit canvas within viewport while preserving aspect
        const maxW = Math.min(window.innerWidth*0.95, img.width);
        const maxH = Math.min(window.innerHeight*0.80, img.height);
        let cw = img.width, ch = img.height;
        const scale = Math.min(maxW/img.width, maxH/img.height);
        if (scale < 1) { cw = Math.round(img.width*scale); ch = Math.round(img.height*scale); }
        this.canvas.width = cw; this.canvas.height = ch;
        this.overlayCanvas.width = cw; this.overlayCanvas.height = ch;
        this.ctx.drawImage(img, 0, 0, cw, ch);
        this.baseImage = img;
        this.history = []; this.redoStack = []; this.saveSnapshot();
        this.items = []; this.dragItem = null;
      };
      img.crossOrigin = 'anonymous';
      img.src = src;
    }

    resizeToViewport(){
      if (!this.baseImage) return;
      const img = this.baseImage;
      const maxW = Math.min(window.innerWidth*0.95, img.width);
      const maxH = Math.min(window.innerHeight*0.80, img.height);
      let cw = img.width, ch = img.height;
      const scale = Math.min(maxW/img.width, maxH/img.height);
      if (scale < 1) { cw = Math.round(img.width*scale); ch = Math.round(img.height*scale); }
      this.canvas.width = cw; this.canvas.height = ch;
      this.overlayCanvas.width = cw; this.overlayCanvas.height = ch;
      this.redrawAll();
    }

    pos(e){
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX|| (e.touches&&e.touches[0].clientX)) - rect.left;
      const y = (e.clientY|| (e.touches&&e.touches[0].clientY)) - rect.top;
      return {x,y};
    }

    saveSnapshot(){
      try { this.history.push(this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height)); this.redoStack=[]; } catch(err) {}
    }
    undo(){ if(this.history.length>1){ const curr=this.history.pop(); this.redoStack.push(curr); const prev=this.history[this.history.length-1]; this.ctx.putImageData(prev,0,0);} }
    redo(){ if(this.redoStack.length>0){ const data=this.redoStack.pop(); this.history.push(data); this.ctx.putImageData(data,0,0);} }

    clearOverlay(){ this.overlayCtx.clearRect(0,0,this.overlayCanvas.width,this.overlayCanvas.height); }
    previewShape(x2,y2){ this.clearOverlay(); this.overlayCtx.strokeStyle=this.strokeColor; this.overlayCtx.lineWidth=this.strokeSize; if(this.currentTool==='rect'){ this.overlayCtx.strokeRect(this.startX,this.startY,x2-this.startX,y2-this.startY); } else if(this.currentTool==='circle'){ const rx=(x2-this.startX)/2, ry=(y2-this.startY)/2; const cx=this.startX+rx, cy=this.startY+ry; this.overlayCtx.beginPath(); this.overlayCtx.ellipse(cx,cy,Math.abs(rx),Math.abs(ry),0,0,Math.PI*2); this.overlayCtx.stroke(); } else if(this.currentTool==='arrow'){ this.drawArrow(this.startX,this.startY,x2,y2,this.overlayCtx); } }
    drawRect(x1,y1,x2,y2){ this.ctx.strokeStyle=this.strokeColor; this.ctx.lineWidth=this.strokeSize; this.ctx.strokeRect(x1,y1,x2-x1,y2-y1); }
    drawCircle(x1,y1,x2,y2){ this.ctx.strokeStyle=this.strokeColor; this.ctx.lineWidth=this.strokeSize; const rx=(x2-x1)/2, ry=(y2-y1)/2; const cx=x1+rx, cy=y1+ry; this.ctx.beginPath(); this.ctx.ellipse(cx,cy,Math.abs(rx),Math.abs(ry),0,0,Math.PI*2); this.ctx.stroke(); }
    drawArrow(x1,y1,x2,y2,ctxOpt){ const c=ctxOpt||this.ctx; c.save(); c.strokeStyle=this.strokeColor; c.fillStyle=this.strokeColor; c.lineWidth=this.strokeSize; c.beginPath(); c.moveTo(x1,y1); c.lineTo(x2,y2); c.stroke(); const angle=Math.atan2(y2-y1,x2-x1); const head=8+this.strokeSize*1.5; c.beginPath(); c.moveTo(x2,y2); c.lineTo(x2-head*Math.cos(angle-Math.PI/6), y2-head*Math.sin(angle-Math.PI/6)); c.lineTo(x2-head*Math.cos(angle+Math.PI/6), y2-head*Math.sin(angle+Math.PI/6)); c.closePath(); c.fill(); c.restore(); }
    drawRectItem(it){ this.ctx.strokeStyle=it.color; this.ctx.lineWidth=it.size; this.ctx.strokeRect(it.x1,it.y1,it.x2-it.x1,it.y2-it.y1); }
    drawCircleItem(it){ this.ctx.strokeStyle=it.color; this.ctx.lineWidth=it.size; const rx=(it.x2-it.x1)/2, ry=(it.y2-it.y1)/2; const cx=it.x1+rx, cy=it.y1+ry; this.ctx.beginPath(); this.ctx.ellipse(cx,cy,Math.abs(rx),Math.abs(ry),0,0,Math.PI*2); this.ctx.stroke(); }
    drawArrowItem(it){ const prevC=this.strokeColor, prevS=this.strokeSize; this.strokeColor=it.color; this.strokeSize=it.size; this.drawArrow(it.x1,it.y1,it.x2,it.y2,this.ctx); this.strokeColor=prevC; this.strokeSize=prevS; }
    drawTextItem(it){ this.ctx.fillStyle=it.color; this.ctx.font=`${Math.max(14, it.size*5)}px sans-serif`; this.ctx.fillText(it.text, it.x1, it.y1); }
    redrawAll(){ this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height); if(this.baseImage){ this.ctx.drawImage(this.baseImage,0,0,this.canvas.width,this.canvas.height); } for(const it of this.items){ if(it.type==='rect') this.drawRectItem(it); else if(it.type==='circle') this.drawCircleItem(it); else if(it.type==='arrow') this.drawArrowItem(it); else if(it.type==='text') this.drawTextItem(it); } }
    hitTest(x,y){ for(let i=this.items.length-1;i>=0;i--){ const it=this.items[i]; if(it.type==='rect'){ if(x>=it.x1 && x<=it.x2 && y>=it.y1 && y<=it.y2) return {it,idx:i}; } else if(it.type==='circle'){ const cx=(it.x1+it.x2)/2, cy=(it.y1+it.y2)/2; const rx=Math.abs((it.x2-it.x1)/2), ry=Math.abs((it.y2-it.y1)/2); const dx=(x-cx)/rx, dy=(y-cy)/ry; if(dx*dx+dy*dy<=1) return {it,idx:i}; } else if(it.type==='arrow'){ const dist=this.pointToSegmentDistance(x,y,it.x1,it.y1,it.x2,it.y2); if(dist<=Math.max(8,it.size+4)) return {it,idx:i}; } else if(it.type==='text'){ this.ctx.font=`${Math.max(14, it.size*5)}px sans-serif`; const w=this.ctx.measureText(it.text).width; const h=Math.max(14, it.size*5); if(x>=it.x1 && x<=it.x1+w && y<=it.y1 && y>=it.y1-h) return {it,idx:i}; } } return null; }
    pointToSegmentDistance(px,py,x1,y1,x2,y2){ const A=px-x1, B=py-y1, C=x2-x1, D=y2-y1; const dot=A*C+B*D; const len=C*C+D*D; let t=len?dot/len:-1; t=Math.max(0,Math.min(1,t)); const dx=x1+t*C-px, dy=y1+t*D-py; return Math.sqrt(dx*dx+dy*dy); }

    async save(){
      // Convert to Blob and upload as new photo
      const projId = await this.ensureProjectId();
      if (!projId) { alert('Project ID missing. Cannot save annotation.'); return; }
      // Ensure vectors drawn on canvas before export
      this.redrawAll();
      this.canvas.toBlob(async (blob)=>{
        try {
          const fileName = `annotated_${this.photoId || 'photo'}_${Date.now()}.jpg`;
          const fd = new FormData();
          fd.append('project_id', projId);
          fd.append('file', blob, fileName);
          if (this.photoId) { fd.append('source_photo_id', this.photoId); }
          console.log('[PHOTO-EDITOR] Uploading annotation', { project_id: projId, fileName });
          const res = await fetch('/api/photos/local_upload', { method:'POST', body: fd, credentials: 'same-origin' });
          let respText = '';
          try { respText = await res.clone().text(); } catch(e) {}
          if(!res.ok){
            console.error('[PHOTO-EDITOR] Upload failed', res.status, respText);
            try { const j = JSON.parse(respText); alert(j.error || `Upload failed (${res.status})`); } catch(e){ alert(`Upload failed (${res.status})`); }
            return;
          }
          const data = JSON.parse(respText || '{}');
          if(!data.ok){ alert(data.error||'Upload failed'); return; }
          this.close();
          location.reload();
        } catch(err){
          console.error('Photo editor upload error', err);
          alert('Upload error');
        }
      }, 'image/jpeg', 0.9);
    }

    async ensureProjectId(){
      if (this.projectId) return this.projectId;
      if (!this.photoId) return null;
      try {
        const res = await fetch(`/api/photos/${this.photoId}/metadata`, { credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = await res.json();
        const pid = data && data.project && data.project.id;
        if (pid) { this.projectId = pid; }
        return this.projectId;
      } catch(e){
        return null;
      }
    }

    close(){ if(this.modal){ this.modal.remove(); this.modal=null; } }
  }

  const editor = new PhotoEditor();
  window.openPhotoEditor = function(photoId, projectId, photoSrc){ editor.open(photoId, projectId, photoSrc); };
})();


