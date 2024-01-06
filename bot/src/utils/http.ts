import axios from "axios";
import dotenv from "dotenv-safe";
import invariant from "tiny-invariant";

dotenv.config();

const baseURL = process.env.API_URL;

// create an instance of axios
export const AxiosInstance = axios.create({
  baseURL,
});
