const dotenv = require("dotenv");

dotenv.config();

module.exports = ({ config }) => {
  return {
    ...config,
    extra: {
      ...config.extra,
      assemblyaiApiKey: process.env.ASSEMBLYAI_API_KEY || "",
      geniusAccessToken: process.env.GENIUS_ACCESS_TOKEN || "",
      rapidApiKey: process.env.RAPIDAPI_KEY || "",
    },
  };
};
