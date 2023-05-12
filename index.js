import { Configuration, OpenAIApi } from "openai";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
} from "discord.js";

// подгружаем файл .env
dotenv.config();

// OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAPI_TOKEN,
});
const openai = new OpenAIApi(configuration);

// сохранения
let openaiUsers = [],
  openaiThreads = [];

function loadFiles() {
  // id пользователей с доступом к боту
  openaiUsers = new Map(Object.entries(JSON.parse(fs.readFileSync("openaiUsers.json", "utf-8"))));

  // id чатов, где бот отвечает на вопросы
  openaiThreads = new Map(Object.entries(JSON.parse(fs.readFileSync("openaiChats.json", "utf-8"))));
}

// сохранение тредов
async function saveDiscordThreads() {
  await fs.writeFile(
    "./openaiChats.json",
    JSON.stringify(Object.fromEntries(openaiThreads)),
    (err) => {
      if (err) {
        console.log(err);
      }
    }
  );
}

// сохранение пользователей
async function saveOpenaiUsers() {
  await fs.writeFile(
    "./openaiUsers.json",
    JSON.stringify(Object.fromEntries(openaiUsers)),
    (err) => {
      if (err) {
        console.log(err);
      }
    }
  );
}

// Discord бот
const dBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// стартовый скрипт бота
dBot.once("ready", async () => {
  // подключение файлов
  loadFiles();

  console.log(`Ready! Logged in as ${dBot.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_BOT_TOKEN
  );
  await rest.put(Routes.applicationCommands(process.env.DISCORD_BOT_ID), {
    body: [
      new SlashCommandBuilder()
        .setName("gpt")
        .setDescription("Вопрос к chatGPT")
        .addStringOption((option) =>
          option.setName("query").setDescription("Запрос").setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("gpt-thread")
        .setDescription("Создать длительный диалог с ChatGPT"),
      new SlashCommandBuilder()
        .setName("stop-gpt-thread")
        .setDescription("Удалить текущий тред"),
    ],
  });

  //mainJob.start();
});

// обработка команд Discord
dBot.on(Events.InteractionCreate, async (interaction) => {
  if (openaiUsers.get(interaction.user.id.toString()) === 0) {
    interaction.reply("В доступе отказано.");
    return;
  }

  if (
    openaiUsers.get(interaction.user.id.toString()) > 0
  ) {
    openaiUsers.set(interaction.user.id.toString(), openaiUsers.get(interaction.user.id.toString()) - 1);
    await saveOpenaiUsers();
  }

  if (interaction.commandName === "gpt") {
    await interaction.deferReply({ ephemeral: false });

    let response;
    try {
      response = await openai.createCompletion({
        model: "text-davinci-003",
        prompt: interaction.options.getString("query"),
        max_tokens: 3000,
      });
    } catch (err) {
      console.log(err);
      interaction.editReply("Ошибка");
      return;
    }

    interaction.editReply(response.data.choices[0].text);
  } else if (interaction.commandName === "gpt-thread") {
    const thread = await interaction.channel.threads.create({
      name: interaction.user.username,
      autoArchiveDuration: 60,
    });

    const now = new Date();

    openaiThreads.set(thread.id, now);
    await saveDiscordThreads();
    interaction.reply("Тред создан.");
  } else if (interaction.commandName === "stop-gpt-thread") {
    // удаляем тред из базы
    openaiThreads.delete(interaction.channel.id);

    // сохраняем базу
    await saveDiscordThreads();

    // пишем, что тред остановлен
    await interaction.reply("Тред больше не отслеживается.");
  } else {
    interaction.reply({ content: "Такой команды нет!" });
  }
});

// обработчик OpenAI тредов
dBot.on("messageCreate", async (message) => {
  // защиты:
  // от сообщений ботов
  if (message.author.bot) return;
  // от обработки лишних чатов
  if (!openaiThreads.has(message.channel.id)) return;
  // от комментариев пользователей
  if (message.content.startsWith("#")) return;
  // от пользователей без права использовать бота
  if (openaiUsers.get(message.author.id.toString()) === undefined) {
    message.reply('В доступе отказано.');
    return;
  }
  if (openaiUsers.get(message.author.id.toString()) === 0) {
    message.reply('Пробные сообщения закончились :)');
    return;
  }
  if (
    openaiUsers.get(message.author.id.toString()) > 0
  ) {
    openaiUsers.set(message.author.id.toString(), openaiUsers.get(message.author.id.toString()) - 1);
    await saveOpenaiUsers();
  }

  // стартовая информация для бота
  // Перси, только попробуй заменить на Бенарес..
  let conversationLog = [
    {
      role: "system",
      content: "Тебя зовут Самир.",
    },
  ];

  try {
    // получаем сообщения
    let prevMessages = await message.channel.messages.fetch();

    // инвертируем сообщения
    prevMessages.reverse();

    // если это первое сообщение
    if (prevMessages.size === 1) {
      // переименовываем тред
      message.channel.setName(prevMessages.first().content.slice(0, 100));
    }

    // обрабатываем предыдущие сообщения
    prevMessages.forEach((msg) => {
      if (!msg.content.startsWith("\\")) {
        conversationLog.push({
          role: "user",
          content: msg.content,
        });
      }
    });

    // отправляем сигнал, что что-то пишем
    await message.channel.sendTyping();

    // отправляем запрос к GPT
    let result;
    result = await openai
      .createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: conversationLog,
      })
      .catch(async (error) => {
        console.log(error);
        // отжидаемся
        setTimeout(() => {}, 10000);
        result = await openai
          .createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: conversationLog,
          })
          .catch(async (error) => {
            console.log(`OPENAI ERR: ${error}`);
            await message.channel.send("Попробуйте ещё раз позже.");
            return;
          });
      });

    if (result === undefined) message.reply("Не пришёл ответ от нейросети.");

    // разбиваем ответ на сообщения в 2000 символов
    let responses = [];
    for (
      let i = 0;
      i < result.data.choices[0].message.content.length;
      i += 2000
    ) {
      responses.push(
        result.data.choices[0].message.content.substr(i, i + 2000)
      );
    }

    // отправляем ответы
    responses.forEach(async (response) => {
      await message.channel.send(response);
    });
  } catch (error) {
    console.log(`ERR: ${error}`);
    message.reply("error");
  }
});

dBot.login(process.env.DISCORD_BOT_TOKEN);
