import { App, Plugin, PluginSettingTab, Setting, normalizePath, Notice, requestUrl } from 'obsidian';

// Remember to rename these classes and interfaces!

interface Chat {
	id: string;
	summary?: string;
	createdAt: string;
	startedAt: string;
	messages: ChatMessage[];
	visibility: 'private' | 'public' | 'internal';
}

interface ChatMessage {
	id: string;
	text?: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
	createdAt: string;
	user: {
		role: 'user' | 'assistant' | 'system' | 'tool';
		name?: string;
	};
}

interface ToolCall {
	id: string;
	toolName: string;
	args?: any;
}

interface ToolResult {
	result: any;
	isError: boolean;
	toolCallId: string;
	toolName: string;
	entriesReturned?: Array<{
		title: string;
		id: string;
	}>;
}

interface LimitlessLifelogsSettings {
	apiKey: string;
	folderPath: string;
	startDate: string;
	// Chat settings
	chatFolderPath: string;
	syncChats: boolean;
	chatFileFormat: 'daily' | 'per-chat' | 'monthly';
	maxChatsPerSync: number;
}

const DEFAULT_SETTINGS: LimitlessLifelogsSettings = {
	apiKey: '',
	folderPath: 'Limitless Lifelogs',
	startDate: '2025-02-09',
	// Chat defaults
	chatFolderPath: 'Limitless Chats',
	syncChats: false,
	chatFileFormat: 'per-chat',
	maxChatsPerSync: 50
}

export default class LimitlessLifelogsPlugin extends Plugin {
	settings: LimitlessLifelogsSettings;
	api: LimitlessAPI;

	async onload() {
		await this.loadSettings();
		this.api = new LimitlessAPI(this.settings.apiKey);

		// Add settings tab
		this.addSettingTab(new LimitlessLifelogsSettingTab(this.app, this));

		// Add ribbon icon for syncing
		this.addRibbonIcon('sync', 'Sync Limitless Data', async (evt: MouseEvent) => {
			if (evt.ctrlKey || evt.metaKey) {
				// Ctrl/Cmd + Click for chats only
				await this.syncChats();
			} else if (evt.shiftKey) {
				// Shift + Click for both
				await Promise.all([
					this.syncLifelogs(),
					this.syncChats()
				]);
			} else {
				// Default: lifelogs only
				await this.syncLifelogs();
			}
		});

		// Add commands for syncing
		this.addCommand({
			id: 'sync-limitless-lifelogs',
			name: 'Sync Lifelogs',
			callback: async () => {
				await this.syncLifelogs();
			}
		});

		this.addCommand({
			id: 'sync-limitless-chats',
			name: 'Sync Chats',
			callback: async () => {
				await this.syncChats();
			}
		});

		this.addCommand({
			id: 'sync-all-limitless',
			name: 'Sync All (Lifelogs + Chats)',
			callback: async () => {
				await Promise.all([
					this.syncLifelogs(),
					this.syncChats()
				]);
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.api) {
			this.api.setApiKey(this.settings.apiKey);
		}
	}

	async syncLifelogs() {
		if (!this.settings.apiKey) {
			new Notice('Please set your Limitless API key in settings');
			return;
		}

		try {
			// Ensure the folder exists
			const folderPath = normalizePath(this.settings.folderPath);
			await this.ensureFolderExists(folderPath);

			// Get the last synced date
			const lastSyncedDate = await this.getLastSyncedDate();
			const startDate = lastSyncedDate || new Date(this.settings.startDate);
			const endDate = new Date();

			new Notice('Starting Limitless lifelog sync...');

			const currentDate = new Date(startDate);
			while (currentDate <= endDate) {
				const dateStr = currentDate.toISOString().split('T')[0];
				const logs = await this.api.getLifelogs(currentDate);

				if (logs && logs.length > 0) {
					const content = logs.map(log => this.formatLifelogMarkdown(log)).join('\n\n');
					const filePath = `${folderPath}/${dateStr}.md`;
					await this.app.vault.adapter.write(filePath, content);
					new Notice(`Synced entries for ${dateStr}`);
				}

				currentDate.setDate(currentDate.getDate() + 1);
			}

			new Notice('Limitless lifelog sync complete!');
		} catch (error) {
			console.error('Error syncing lifelogs:', error);
			new Notice('Error syncing Limitless lifelogs. Check console for details.');
		}
	}

	private async ensureFolderExists(path: string) {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) {
			await this.app.vault.createFolder(path);
		}
	}

	private async getLastSyncedDate(): Promise<Date | null> {
		const folderPath = normalizePath(this.settings.folderPath);
		try {
			const files = this.app.vault.getFiles()
				.filter(file => file.path.startsWith(folderPath + '/'))
				.filter(file => file.path.endsWith('.md'))
				.map(file => file.basename)
				.filter(basename => /^\d{4}-\d{2}-\d{2}$/.test(basename))
				.map(basename => new Date(basename))
				.sort((a, b) => b.getTime() - a.getTime());

			return files.length > 0 ? files[0] : null;
		} catch {
			return null;
		}
	}

	private formatLifelogMarkdown(lifelog: any): string {
		if (lifelog.markdown) {
			// Reformat Markdown
			const reformattedMarkdown = lifelog.markdown.replaceAll('\n\n', '\n');
			return reformattedMarkdown;
		}

		const content: string[] = [];

		if (lifelog.title) {
			content.push(`# ${lifelog.title}\n`);
		}

		if (lifelog.contents) {
			let currentSection = '';
			let sectionMessages: string[] = [];

			for (const node of lifelog.contents) {
				if (node.type === 'heading2') {
					if (currentSection && sectionMessages.length > 0) {
						content.push(`## ${currentSection}\n`);
						content.push(...sectionMessages);
						content.push('');
					}
					currentSection = node.content;
					sectionMessages = [];
				} else if (node.type === 'blockquote') {
					const speaker = node.speakerName || 'Speaker';
					let timestamp = '';
					if (node.startTime) {
						const dt = new Date(node.startTime);
						timestamp = dt.toLocaleString('en-US', {
							month: '2-digit',
							day: '2-digit',
							year: '2-digit',
							hour: 'numeric',
							minute: '2-digit',
							hour12: true
						});
						timestamp = `(${timestamp})`;
					}

					const message = `- ${speaker} ${timestamp}: ${node.content}`;
					if (currentSection) {
						sectionMessages.push(message);
					} else {
						content.push(message);
					}
				} else if (node.type !== 'heading1') {
					content.push(node.content);
				}
			}

			if (currentSection && sectionMessages.length > 0) {
				content.push(`## ${currentSection}\n`);
				content.push(...sectionMessages);
			}
		}

		return content.join('\n\n');
	}

	async syncChats() {
		if (!this.settings.syncChats) {
			return;
		}

		if (!this.settings.apiKey) {
			new Notice('Please set your Limitless API key in settings');
			return;
		}

		try {
			const chatFolderPath = normalizePath(this.settings.chatFolderPath);
			await this.ensureFolderExists(chatFolderPath);

			new Notice('Starting chat sync...');

			let cursor: string | undefined;
			let processedChats = 0;

			do {
				const result = await this.api.getChats({
					cursor,
					limit: Math.min(this.settings.maxChatsPerSync || 50, 100),
					direction: 'desc',
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
				});

				for (const chat of result.chats || []) {
					await this.processChatFile(chat, chatFolderPath);
					processedChats++;
				}

				cursor = result.meta?.chats?.nextCursor;
			} while (cursor && processedChats < (this.settings.maxChatsPerSync || 200));

			new Notice(`Chat sync complete! Processed ${processedChats} chats.`);
		} catch (error) {
			console.error('Error syncing chats:', error);
			new Notice('Error syncing chats. Check console for details.');
		}
	}

	private async processChatFile(chat: Chat, folderPath: string) {
		try {
			const filePath = this.getChatFilePath(chat, folderPath);
			const content = this.formatChatMarkdown(chat);

			// Check if file exists and compare content
			const existingContent = await this.getExistingFileContent(filePath);
			if (existingContent !== content) {
				await this.app.vault.adapter.write(filePath, content);
			}
		} catch (error) {
			console.error('Error processing chat file:', error);
		}
	}

	private async getExistingFileContent(filePath: string): Promise<string | null> {
		try {
			return await this.app.vault.adapter.read(filePath);
		} catch {
			return null;
		}
	}

	private getChatFilePath(chat: Chat, folderPath: string): string {
		const date = new Date(chat.createdAt);

		switch (this.settings.chatFileFormat) {
			case 'per-chat':
				const safeTitle = this.sanitizeFilename(chat.summary || `Chat ${chat.id}`);
				return `${folderPath}/${safeTitle} - ${chat.id.slice(0, 8)}.md`;

			case 'daily':
				return `${folderPath}/${date.toISOString().split('T')[0]} - Chats.md`;

			case 'monthly':
				return `${folderPath}/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')} - Chats.md`;

			default:
				return `${folderPath}/${chat.id}.md`;
		}
	}

	private sanitizeFilename(name: string): string {
		return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
	}

	private formatChatMarkdown(chat: Chat): string {
		const content: string[] = [];

		// Header with metadata
		content.push(`# ${chat.summary || 'Chat Conversation'}`);
		content.push(`**Chat ID:** ${chat.id}`);
		content.push(`**Created:** ${new Date(chat.createdAt).toLocaleString()}`);
		content.push(`**Started:** ${new Date(chat.startedAt).toLocaleString()}`);
		content.push(`**Visibility:** ${chat.visibility}`);
		content.push('');

		// Process messages
		if (chat.messages && chat.messages.length > 0) {
			content.push('## Conversation');
			content.push('');

			for (const message of chat.messages) {
				content.push(`### ${this.formatRole(message.user.role)} ${message.user.name || ''}`);
				content.push(`*${new Date(message.createdAt).toLocaleString()}*`);
				content.push('');

				if (message.text) {
					content.push(message.text);
					content.push('');
				}

				// Format tool calls
				if (message.toolCalls && message.toolCalls.length > 0) {
					content.push('**Tool Calls:**');
					for (const toolCall of message.toolCalls) {
						content.push(`- ${toolCall.toolName}: \`${JSON.stringify(toolCall.args)}\``);
					}
					content.push('');
				}

				// Format tool results
				if (message.toolResults && message.toolResults.length > 0) {
					content.push('**Tool Results:**');
					for (const result of message.toolResults) {
						content.push(`- ${result.toolName}: ${result.isError ? 'Error' : 'Success'}`);
						if (result.entriesReturned) {
							for (const entry of result.entriesReturned) {
								content.push(`  - [[${entry.title}]] (${entry.id})`);
							}
						}
					}
					content.push('');
				}

				content.push('---');
				content.push('');
			}
		}

		return content.join('\n');
	}

	private formatRole(role: string): string {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}
}

class LimitlessLifelogsSettingTab extends PluginSettingTab {
	plugin: LimitlessLifelogsPlugin;

	constructor(app: App, plugin: LimitlessLifelogsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Your Limitless AI API key')
			.addText(text => text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Folder path')
			.setDesc('Where to store the lifelog entries')
			.addText(text => text
				.setPlaceholder('Folder path')
				.setValue(this.plugin.settings.folderPath)
				.onChange(async (value) => {
					this.plugin.settings.folderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Start date')
			.setDesc('Default start date for initial sync (YYYY-MM-DD)')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.startDate)
				.onChange(async (value) => {
					this.plugin.settings.startDate = value;
					await this.plugin.saveSettings();
				}));

		// Chat Settings Section
		containerEl.createEl('h2', {text: 'Chat Settings'});

		new Setting(containerEl)
			.setName('Enable chat sync')
			.setDesc('Sync your Ask AI conversation history')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncChats)
				.onChange(async (value) => {
					this.plugin.settings.syncChats = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Chat folder path')
			.setDesc('Where to store chat conversations')
			.addText(text => text
				.setPlaceholder('Folder path')
				.setValue(this.plugin.settings.chatFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.chatFolderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Chat file format')
			.setDesc('How to organize chat files')
			.addDropdown(dropdown => dropdown
				.addOptions({
					'per-chat': 'One file per chat',
					'daily': 'Daily chat summaries',
					'monthly': 'Monthly chat archives'
				})
				.setValue(this.plugin.settings.chatFileFormat)
				.onChange(async (value) => {
					this.plugin.settings.chatFileFormat = value as 'daily' | 'per-chat' | 'monthly';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max chats per sync')
			.setDesc('Maximum number of chats to sync at once (1-200)')
			.addSlider(slider => slider
				.setLimits(1, 200, 10)
				.setValue(this.plugin.settings.maxChatsPerSync)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxChatsPerSync = value;
					await this.plugin.saveSettings();
				}));
	}
}

class LimitlessAPI {
	private apiKey: string;
	private baseUrl = 'https://api.limitless.ai';
	private batchSize = 10;
	private maxRetries = 5;
	private retryDelay = 1000; // 1 second

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	setApiKey(apiKey: string) {
		this.apiKey = apiKey;
	}

	async getLifelogs(date: Date): Promise<any[]> {
		const allLifelogs: any[] = [];
		let cursor: string | null = null;

		const params = new URLSearchParams({
			date: date.toISOString().split('T')[0],
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			includeMarkdown: 'true',
			includeHeadings: 'true',
			direction: 'asc',
			limit: this.batchSize.toString()
		});

		do {
			if (cursor) {
				params.set('cursor', cursor);
			}

			try {
				const data = await this.makeRequest(`${this.baseUrl}/v1/lifelogs`, params);
				const lifelogs = data.data?.lifelogs || [];
				allLifelogs.push(...lifelogs);

				cursor = data.meta?.lifelogs?.nextCursor || null;
			} catch (error) {
				console.error('Error fetching lifelogs:', error);
				throw error;
			}
		} while (cursor);

		return allLifelogs;
	}

	async getChats(params: {
		cursor?: string;
		direction?: 'asc' | 'desc';
		limit?: number;
		timezone?: string;
		isScheduled?: boolean;
		globalPromptId?: string;
	}): Promise<{chats: Chat[], meta: any}> {
		try {
			const searchParams = new URLSearchParams();
			
			if (params.cursor) searchParams.set('cursor', params.cursor);
			if (params.direction) searchParams.set('direction', params.direction);
			if (params.limit) searchParams.set('limit', params.limit.toString());
			if (params.timezone) searchParams.set('timezone', params.timezone);
			if (params.isScheduled !== undefined) searchParams.set('isScheduled', params.isScheduled.toString());
			if (params.globalPromptId) searchParams.set('globalPromptId', params.globalPromptId);

			const response = await this.makeRequest(`${this.baseUrl}/v1/chats`, searchParams);
			return {
				chats: response.data?.chats || [],
				meta: response.meta
			};
		} catch (error) {
			if (error.status === 404) {
				throw new Error('Chats not found or access denied');
			} else if (error.status === 401) {
				throw new Error('Invalid API key or unauthorized access');
			}
			throw error;
		}
	}

	async getChat(id: string, timezone?: string): Promise<Chat> {
		try {
			const params = new URLSearchParams();
			if (timezone) params.set('timezone', timezone);

			const response = await this.makeRequest(`${this.baseUrl}/v1/chats/${id}`, params);
			return response.data;
		} catch (error) {
			if (error.status === 404) {
				throw new Error('Chat not found or access denied');
			} else if (error.status === 401) {
				throw new Error('Invalid API key or unauthorized access');
			}
			throw error;
		}
	}

	async deleteChat(id: string): Promise<{success: boolean}> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/v1/chats/${id}`,
				method: 'DELETE',
				headers: {
					'X-API-Key': this.apiKey,
					'Content-Type': 'application/json'
				}
			});
			return {success: true};
		} catch (error) {
			if (error.status === 404) {
				throw new Error('Chat not found or access denied');
			} else if (error.status === 401) {
				throw new Error('Invalid API key or unauthorized access');
			}
			throw error;
		}
	}

	private async makeRequest(url: string, params: URLSearchParams): Promise<any> {
		let retries = 0;
		while (true) {
			try {
				const response = await requestUrl({
					url: `${url}?${params.toString()}`,
					method: 'GET',
					headers: {
						'X-API-Key': this.apiKey,
						'Content-Type': 'application/json'
					}
				});

				if (!response.json) {
					throw new Error('Invalid response format');
				}

				return response.json;
			} catch (error) {
				if (error.status === 429 && retries < this.maxRetries) {
					let delay = this.retryDelay * Math.pow(2, retries);
					const retryAfter = error.headers?.['retry-after'];

					if (retryAfter) {
						const retryAfterSeconds = parseInt(retryAfter, 10);
						if (!isNaN(retryAfterSeconds)) {
							delay = retryAfterSeconds * 1000;
						} else {
							const retryAfterDate = new Date(retryAfter);
							const now = new Date();
							delay = retryAfterDate.getTime() - now.getTime();
						}
					}

					new Notice(`Rate limit exceeded. Retrying in ${Math.round(delay / 1000)} seconds...`);
					await new Promise(resolve => setTimeout(resolve, delay));
					retries++;
				} else {
					console.error('Error making request:', error);
					throw error;
				}
			}
		}
	}
}
