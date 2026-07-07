'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation.js';
import type { ProjectRow } from '@minicoder/api';

export function ProjectSwitcher({
  projects,
  currentProjectId,
}: {
  projects: ProjectRow[];
  currentProjectId: string;
}): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleChange = (projectId: string): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('project', projectId);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <select
      value={currentProjectId}
      onChange={(e) => handleChange(e.target.value)}
      aria-label="Select project"
    >
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
