import { redirect } from "next/navigation";

/** `/signup` is the sign-in screen opened on account creation. */
export default function SignupPage() {
  redirect("/login?mode=signup");
}
