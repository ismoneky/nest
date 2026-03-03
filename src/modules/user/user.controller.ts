import { BadRequestException, Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateUserDto } from './dto/createUser.dto';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
    constructor(private userService: UserService) {}

    @Post('login')
    async loginOrRegister(@Body() createUserDto: CreateUserDto, @Res() res: Response) {
        try {
            const user = await this.userService.findOrCreateUser(createUserDto);
            return res.status(HttpStatus.OK).send({
                success: true,
                message: user.createdAt.getTime() === user.updatedAt?.getTime() ? 'User created successfully' : 'User logged in successfully',
                data: user,
            });
        } catch (error) {
            throw new BadRequestException(error);
        }
    }
}
