import { redirect } from 'next/navigation.js';

export default function RootPage(): never {
  redirect('/dashboard');
}
