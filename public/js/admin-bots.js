(function(){
  const rows = window.ADMIN_BOT_STRATEGY_ROWS || [];

  function n(v){ return Number(v) || 0; }

  function nearestRow(capital){
    if(!rows.length) return null;
    return rows.slice().sort((a,b)=>
      Math.abs(n(a.capital_recommended)-capital) -
      Math.abs(n(b.capital_recommended)-capital)
    )[0];
  }

  function calcPercent(lot, port, pkgText){
    let factor = 2;
    const p = String(pkgText || '').toUpperCase();
    if(p.includes('PRO')) factor = 2.8;
    if(p.includes('ADVANCED')) factor = 3.5;
    return lot * port * factor * 10;
  }

  function update(){
    const capitalEl = document.querySelector('[name="capital"]');
    const percentEl = document.querySelector('[name="target_profit_percent"]');
    const amountEl = document.querySelector('[name="target_profit_amount"]');
    const lotEl = document.querySelector('[name="lot"]');
    const portEl = document.querySelector('[name="port"]');
    const pkgEl = document.querySelector('[name="package_id"]');
    const preview = document.getElementById('bot-calc-preview');

    let capital = n(capitalEl?.value);
    const targetPercent = n(percentEl?.value);

    const opt = pkgEl?.selectedOptions?.[0];
    const pkgText = opt?.textContent || '';
    const lotMax = n(opt?.dataset?.lotMax);
    const portMax = n(opt?.dataset?.portMax);

    if(!capital && targetPercent > 0){
      for(const row of rows){
        const cap = n(row.capital_recommended);
        let lot = n(row.lot_size);
        let port = Math.max(1, Math.round(cap / 75));

        if(lotMax > 0 && lot > lotMax) lot = lotMax;
        if(portMax > 0 && port > portMax) port = portMax;

        const p = calcPercent(lot, port, pkgText);
        if(p >= targetPercent){
          capital = cap;
          if(capitalEl) capitalEl.value = cap.toFixed(2);
          break;
        }
      }
    }

    if(!capital) return;

    const row = nearestRow(capital);
    if(!row) return;

    let finalLot = lotEl?.value ? n(lotEl.value) : n(row.lot_size);
    let finalPort = portEl?.value ? n(portEl.value) : Math.max(1, Math.round(capital / 75));

    let warning = '';

    if(lotMax > 0 && finalLot > lotMax){
      warning += `แพ็กเกจนี้ใช้ Lot ได้สูงสุด ${lotMax}<br>`;
      finalLot = lotMax;
    }

    if(portMax > 0 && finalPort > portMax){
      warning += `แพ็กเกจนี้ใช้ Port ได้สูงสุด ${portMax}<br>`;
      finalPort = portMax;
    }

    const percent = calcPercent(finalLot, finalPort, pkgText);
    const amount = capital * percent / 100;

    if(percentEl) percentEl.value = percent.toFixed(2);
    if(amountEl) amountEl.value = amount.toFixed(2);

    if(preview){
      preview.innerHTML = `
        <strong>ค่าที่ระบบแนะนำ</strong><br>
        ทุน: ${capital.toFixed(2)} US<br>
        Lot: ${finalLot}<br>
        Port: ${finalPort}<br>
        กำไรประมาณ: ${percent.toFixed(2)}% = ${amount.toFixed(2)} US
        ${warning ? `<div style="color:#fecaca;margin-top:8px">${warning}</div>` : ''}
      `;
    }
  }

  document.addEventListener('input', update);
  document.addEventListener('change', update);
  setTimeout(update, 300);
})();