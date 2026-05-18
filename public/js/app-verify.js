(function () {
  const form = document.getElementById('profileVerifyForm');
  const sendCodeBtn = document.getElementById('sendVerifyCodeBtn');
  const messageBox = document.getElementById('verifyProfileMessage');

  function showMessage(message, type) {
    if (!messageBox) return;
    messageBox.textContent = message || '';
    messageBox.className = 'verify-profile-message ' + (type || 'info');
    messageBox.style.display = 'block';
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload || {})
    });

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }

    return { response, data };
  }

  if (sendCodeBtn) {
    sendCodeBtn.addEventListener('click', async function () {
      sendCodeBtn.disabled = true;
      try {
        const result = await postJson('/api/auth/profile-verification/send-code', {});
        if (!result.response.ok || !result.data.ok) {
          showMessage(result.data.message || 'ส่งรหัสไม่สำเร็จ', 'error');
          return;
        }
        showMessage(result.data.message || 'ส่งรหัสไปที่อีเมลแล้ว', 'success');
      } catch (error) {
        showMessage('เครือข่ายมีปัญหา กรุณาลองใหม่', 'error');
      } finally {
        sendCodeBtn.disabled = false;
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const formData = Object.fromEntries(new FormData(form).entries());

      try {
        const result = await postJson('/api/auth/profile-verification/confirm', formData);
        if (!result.response.ok || !result.data.ok) {
          showMessage(result.data.message || 'ยืนยันตัวตนไม่สำเร็จ', 'error');
          submitBtn.disabled = false;
          return;
        }

        showMessage(result.data.message || 'ยืนยันตัวตนสำเร็จ', 'success');
        setTimeout(function () {
          window.location.href = result.data.redirect || '/app';
        }, 700);
      } catch (error) {
        showMessage('เครือข่ายมีปัญหา กรุณาลองใหม่', 'error');
        submitBtn.disabled = false;
      }
    });
  }
})();