
async function askAI(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('ราคา') || text.includes('แพ็กเกจ')) {
    return 'ตอนนี้มีแพ็กเกจ BASIC, PRO และ ADVANCED ค่ะ สามารถดูรายละเอียดที่หน้าแพ็กเกจได้เลยค่ะ';
  }
  if (text.includes('สมัคร') || text.includes('เริ่ม')) {
    return 'เริ่มต้นโดยสมัครสมาชิก ยืนยันอีเมล เข้าสู่ระบบ และเลือกแพ็กเกจได้เลยค่ะ';
  }
  if (text.includes('หุ้น') || text.includes('ทอง') || text.includes('คริปโต')) {
    return 'สามารถดูภาพรวมตลาดและข่าวได้จากหน้า ตลาด และ ข่าว ของเว็บไซต์ค่ะ';
  }
  return 'AI Support พร้อมช่วยเรื่องการใช้งาน ราคาแพ็กเกจ ข่าวตลาด และคำถามเบื้องต้นของลูกค้าค่ะ';
}
module.exports = { askAI };
