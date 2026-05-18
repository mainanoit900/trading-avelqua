'use strict';

const MT5_LOCKED_SERVER = process.env.MT5_DEFAULT_SERVER || 'MohicansMarkets-Live';
const MT5_LOCKED_COMPANY = 'Mohicans Markets Ltd';
const MT5_SUCCESS_MSG = 'เชื่อมต่อสำเร็จ';
const MT5_FAIL_USER_MSG = 'Login หรือ Password ไม่ถูกต้อง';

function normalizeLockedServer(serverName) {
  return MT5_LOCKED_SERVER;
}

module.exports = {
  MT5_LOCKED_SERVER,
  MT5_LOCKED_COMPANY,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  normalizeLockedServer
};
