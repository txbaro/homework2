const dotenv = require("dotenv");

dotenv.config();

module.exports = ({ config }) => {
  return {
    ...config,
    extra: {
      ...config.extra,
      assemblyaiApiKey:
        process.env.ASSEMBLYAI_API_KEY || "2513c96e245c45d69b424a234f670f9c",
      geniusAccessToken:
        process.env.GENIUS_ACCESS_TOKEN ||
        "F3lpLJNHaZVRgR556A171PL9FNyyonAW7S9pi8LOAujMjx1HJ27jjEE-QlBHAiDQ-8g-_uP6ihhrv0sRe79D8y-k",
      rapidApiKey:
        process.env.RAPIDAPI_KEY ||
        "18f82c89b4msh291eea1f338e4fep1465e8jsna1921469646f",
    },
  };
};
