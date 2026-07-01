// Danh sách category cố định (closed-set).
// Khi cần thêm/bớt, chỉ sửa ở đây — toàn bộ pipeline dùng chung file này.
export const CATEGORIES = [
  // Frontend / Web
  "Web Frontend",
  "Web Framework",
  "UI/Component Library",
  "CSS/Styling",
  // Backend / Infra
  "Backend Framework",
  "API/GraphQL",
  "Microservices",
  "Serverless",
  "DevOps/CI-CD",
  "Infrastructure as Code",
  "Cloud/Hosting",
  // Mobile / Desktop
  "Mobile (iOS/Android)",
  "Cross-platform Mobile",
  "Desktop App",
  // AI/ML
  "AI/LLM",
  "Machine Learning",
  "Computer Vision",
  "NLP",
  "AI Agent/Automation",
  // Data
  "Database",
  "Data Engineering/ETL",
  "Data Visualization",
  "Big Data/Analytics",
  // Dev Tooling
  "CLI Tool",
  "Developer Tool",
  "Build Tool/Bundler",
  "Testing/QA",
  "Code Editor/IDE Extension",
  "Package Manager",
  // Security
  "Security/Pentest",
  "Cryptography",
  // Blockchain
  "Blockchain/Web3",
  // Systems
  "Operating System/Kernel",
  "Networking",
  "Embedded/IoT",
  // Game
  "Game Dev",
  "Game Engine",
  // Content
  "Documentation/Learning Resource",
  "Awesome List/Curated Resource",
  "Boilerplate/Starter Template",
  // Productivity
  "Productivity/Personal Tool",
  "Note-taking/Knowledge Management",
  // Fallback
  "Other",
];

// Chuẩn hoá tên category -> tên file an toàn trong notes/
export function categoryToFilename(category) {
  const safe = CATEGORIES.includes(category) ? category : "Other";
  return (
    safe
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9\- ]/g, "")
      .replace(/\s+/g, "-") + ".md"
  );
}
