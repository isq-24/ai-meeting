export interface TodoItem {
  task: string;
  assignee: string;
  dueDate: string;
}

export interface MeetingMinutes {
  title: string;
  date: string;
  agenda: string[];
  discussion: string[];
  decision: string[];
  todo: TodoItem[];
}

export interface DriveDocument {
  id: string;
  name: string;
  webViewLink: string;
  createdTime: string;
}

export interface ProcessResponse {
  success: boolean;
  documentId?: string;
  documentUrl?: string;
  structuredNotes?: MeetingMinutes;
  transcript?: string;
  error?: string;
}
