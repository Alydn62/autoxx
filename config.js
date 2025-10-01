
module.exports = {
  jasaotp: {
    apiKey: process.env.JASAOTP_API_KEY || "REPLACE_ME",
    negara: parseInt(process.env.JASAOTP_NEGARA || "6", 10),
    layanan: process.env.JASAOTP_LAYANAN || "bnt",
    operator: process.env.JASAOTP_OPERATOR || "any"
  },
  treasury: {
    loginUrl: process.env.TREASURY_LOGIN_URL || "https://www.treasury.id/login",
    password: process.env.TREASURY_PASSWORD || "@Facebook20"
  },
  runtime: {
    expireMinutes: parseInt(process.env.EXPIRE_MINUTES || "10", 10),
    headless: (process.env.HEADLESS || "true") === "true",
    slowMo: parseInt(process.env.SLOW_MO || "0", 10)
  }
};
