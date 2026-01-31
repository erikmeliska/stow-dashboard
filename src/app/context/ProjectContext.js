import React, { createContext, useContext, useState } from 'react';

const ProjectContext = createContext(undefined);

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [filters, setFilters] = useState({
    searchTerm: '',
    technologies: [],
    dateRange: { start: null, end: null }
  });

  const updateFilters = (newFilters) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
  };

  const refreshProjects = async () => {
    // Implementácia načítania projektov
  };

  return (
    <ProjectContext.Provider 
      value={{ 
        projects, 
        selectedProject, 
        filters,
        setSelectedProject,
        updateFilters,
        refreshProjects
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export const useProjects = () => {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProjects must be used within ProjectProvider');
  return context;
}; 