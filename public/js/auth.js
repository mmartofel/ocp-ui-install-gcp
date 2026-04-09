'use strict';

function switchTab(tab) {
  const isUpload = tab === 'upload';
  document.getElementById('panel-upload').classList.toggle('hidden', !isUpload);
  document.getElementById('panel-paste').classList.toggle('hidden',  isUpload);
  document.getElementById('tab-upload').classList.toggle('active', isUpload);
  document.getElementById('tab-paste').classList.toggle('active', !isUpload);
  document.getElementById('tab-upload').classList.toggle('text-slate-400', !isUpload);
  document.getElementById('tab-paste').classList.toggle('text-slate-400', isUpload);
}

// File upload via dropzone
const dropzone  = document.getElementById('dropzone');
const fileInput = document.getElementById('credentialsFile');
const fileName  = document.getElementById('fileName');

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) {
    fileName.textContent = '✓ ' + fileInput.files[0].name;
    fileName.classList.remove('hidden');
  }
});

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('border-rh-red'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-rh-red'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('border-rh-red');
  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    fileName.textContent = '✓ ' + file.name;
    fileName.classList.remove('hidden');
  }
});

// Form submission
document.getElementById('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const btn      = document.getElementById('submitBtn');
  const label    = document.getElementById('submitLabel');
  const spinner  = document.getElementById('submitSpinner');
  const msgEl    = document.getElementById('authMsg');
  const infoEl   = document.getElementById('projectInfo');

  btn.disabled  = true;
  label.textContent = 'Weryfikuję...';
  spinner.classList.remove('hidden');
  msgEl.classList.add('hidden');
  infoEl.classList.add('hidden');

  try {
    const formData = new FormData();

    const uploadPanel = !document.getElementById('panel-upload').classList.contains('hidden');
    if (uploadPanel && fileInput.files[0]) {
      formData.append('credentialsFile', fileInput.files[0]);
    } else {
      const json = document.getElementById('credentialsJson').value.trim();
      if (!json) throw new Error('Wklej lub wgraj plik JSON konta serwisowego.');
      formData.append('credentialsJson', json);
    }

    const resp = await fetch('/auth/credentials', { method: 'POST', body: formData });
    const data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Błąd weryfikacji');
    }

    // Update project info panel
    infoEl.className = 'mt-4 p-3 rounded-lg text-sm border bg-green-900/30 border-green-700';
    document.getElementById('projectInfoStatus').textContent = '✓ Weryfikacja zakończona pomyślnie';
    document.getElementById('projectInfoStatus').className   = 'text-green-300 font-medium mb-1';
    document.getElementById('infoProjectName').textContent   = data.projectName || data.projectId;
    document.getElementById('infoProjectId').textContent     = data.projectId;
    document.getElementById('infoClientEmail').textContent   = data.clientEmail;
    document.getElementById('projectInfoDetails').classList.remove('hidden');

    btn.disabled = false;
    label.textContent = 'Weryfikuj i kontynuuj';
    spinner.classList.add('hidden');

  } catch (err) {
    showMsg(msgEl, err.message, 'error');
    btn.disabled = false;
    label.textContent = 'Weryfikuj i kontynuuj';
    spinner.classList.add('hidden');
  }
});

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `mt-4 p-3 rounded-lg text-sm ${
    type === 'error'
      ? 'bg-red-950/50 border border-red-800 text-red-300'
      : 'bg-green-950/50 border border-green-800 text-green-300'
  }`;
  el.classList.remove('hidden');
}
