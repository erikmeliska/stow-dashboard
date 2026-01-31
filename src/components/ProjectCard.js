import React from 'react';
import { format } from 'date-fns';
import { Folder, GitBranch } from 'lucide-react';

export function ProjectCard({ project, onClick }) {
  return (
    <div 
      onClick={onClick}
      className="p-4 border rounded-lg hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-lg">{project.project_name}</h3>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <GitBranch className="w-4 h-4" />
          <span>{project.git_info.current_branch}</span>
        </div>
      </div>
      
      <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
        <Folder className="w-4 h-4" />
        <span>{project.directory}</span>
      </div>
      
      <div className="flex flex-wrap gap-2 mt-2">
        {project.stack.map(tech => (
          <span 
            key={tech}
            className="px-2 py-1 bg-gray-100 rounded-full text-xs"
          >
            {tech}
          </span>
        ))}
      </div>
      
      <div className="mt-3 text-xs text-gray-500">
        Upravené: {format(new Date(project.last_modified), 'dd.MM.yyyy HH:mm')}
      </div>
    </div>
  );
} 